// 压缩模型顺位池单元测试：
//   1) 配置读取/归一化/原子保存与草稿保留；
//   2) /acp-models 编辑器状态机与按键映射；
//   3) 只读历史快照（mNNNNN / bN / 混合）取文；
//   4) 摘要请求、降级链、超时、取消与上下文隔离。
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createJiti } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const pool = await jiti.import("../compressModels.ts");

/** 创建临时目录（每个测试独立）。 */
async function tempDir(label) {
  const dir = await fs.mkdtemp(path.join(tmpdir(), `acp-pool-${label}-`));
  return dir;
}

function model(provider, id, extra = {}) {
  return { provider, id, name: id, contextWindow: 200_000, ...extra };
}

function registryOf(models, { failAuth = new Set(), complete } = {}) {
  return {
    getAll: () => models,
    find: (provider, modelId) => models.find((m) => m.provider === provider && m.id === modelId),
    hasConfiguredAuth: (m) => !failAuth.has(`${m.provider}/${m.id}`),
    complete: complete ?? (async () => assistantText("summary")),
  };
}

function assistantText(text, extra = {}) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    timestamp: Date.now(),
    ...extra,
  };
}

// ── 1. 配置持久化 ────────────────────────────────────────────────────────

test("missing config falls back to an empty pool without creating files", async () => {
  const dir = await tempDir("missing");
  const file = path.join(dir, "nested", "compress-models.json");
  const loaded = await pool.loadCompressModelsConfig(file);
  assert.equal(loaded.status, "missing");
  assert.deepEqual(loaded.config.models, []);
  await assert.rejects(fs.stat(file));
});

test("corrupt config reports a reason and is never overwritten silently", async () => {
  const dir = await tempDir("corrupt");
  const file = path.join(dir, "compress-models.json");
  await fs.writeFile(file, "{ not json", "utf8");
  const loaded = await pool.loadCompressModelsConfig(file);
  assert.equal(loaded.status, "corrupt");
  assert.match(loaded.error, /JSON/);
  // 未知版本同样按损坏处理，避免猜结构后覆盖
  await fs.writeFile(file, JSON.stringify({ version: 99, models: [] }), "utf8");
  const versioned = await pool.loadCompressModelsConfig(file);
  assert.equal(versioned.status, "corrupt");
  assert.match(versioned.error, /未知配置版本/);
  // 原文件保持原样
  assert.equal(await fs.readFile(file, "utf8"), JSON.stringify({ version: 99, models: [] }));
});

test("normalizes entries, dedupes duplicates, and keeps queue order", async () => {
  const dir = await tempDir("normalize");
  const file = path.join(dir, "compress-models.json");
  await fs.writeFile(
    file,
    JSON.stringify({
      version: 1,
      models: [
        { provider: "sub2", modelId: "deepseek-flash" },
        { provider: "sub2", modelId: "deepseek-flash" },
        { provider: "openai-codex", modelId: "gpt-5.6-luna" },
      ],
    }),
    "utf8",
  );
  const loaded = await pool.loadCompressModelsConfig(file);
  assert.equal(loaded.status, "ok");
  assert.deepEqual(loaded.config.models, [
    { provider: "sub2", modelId: "deepseek-flash" },
    { provider: "openai-codex", modelId: "gpt-5.6-luna" },
  ]);
});

test("saves atomically and leaves no temp files behind", async () => {
  const dir = await tempDir("save");
  const file = path.join(dir, "compress-models.json");
  const saved = await pool.saveCompressModelsConfig(file, {
    version: 1,
    models: [{ provider: "p", modelId: "m" }],
  });
  assert.equal(saved.ok, true);
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")).models, [{ provider: "p", modelId: "m" }]);
  assert.deepEqual((await fs.readdir(dir)).filter((name) => name.includes(".tmp-")), []);
});

test("failed save reports the reason and the draft survives for the next run", async () => {
  const dir = await tempDir("save-fail");
  // 目标路径先占一个同名目录，写入必然失败
  const file = path.join(dir, "compress-models.json");
  await fs.mkdir(file);
  const config = { version: 1, models: [{ provider: "p", modelId: "m" }] };
  const saved = await pool.saveCompressModelsConfig(file, config);
  assert.equal(saved.ok, false);
  assert.ok(saved.error.length > 0);
  pool.rememberCompressModelsDraft(config);
  assert.deepEqual(pool.takeCompressModelsDraft(), config);
  assert.equal(pool.takeCompressModelsDraft(), null); // 只能恢复一次
  pool.clearCompressModelsDraft();
});

test("produces {provider, modelId} style keys and labels without relying on display names", () => {
  assert.equal(pool.compressModelKey({ provider: "sub2", modelId: "deepseek-flash" }), "sub2/deepseek-flash");
  assert.equal(pool.formatCompressModelLabel("sub2", "deepseek-flash"), "deepseek-flash [sub2]");
});

test("resolves the agent config dir with PI_CODING_AGENT_DIR overrides", () => {
  assert.equal(pool.resolveAgentConfigDir({ PI_CODING_AGENT_DIR: "~" }, "/home/u"), "/home/u");
  assert.equal(pool.resolveAgentConfigDir({ PI_CODING_AGENT_DIR: "~/x" }, "/home/u"), path.join("/home/u", "x"));
  assert.equal(pool.resolveAgentConfigDir({ PI_CODING_AGENT_DIR: "X:/custom" }, "/home/u"), "X:/custom");
  assert.equal(
    pool.resolveAgentConfigDir({}, "/home/u"),
    path.join("/home/u", ".pi", "agent"),
  );
});

// ── 2. 编辑器状态机与按键 ───────────────────────────────────────────────

function editorFixture({ enabled = ["sub2/deepseek-flash"], models = [] } = {}) {
  const config = {
    version: 1,
    models: enabled.map((key) => ({ provider: key.split("/")[0], modelId: key.split("/")[1] })),
  };
  const all = models.length > 0
    ? models
    : [model("sub2", "deepseek-flash"), model("openai-codex", "gpt-5.6-luna"), model("anthropic", "claude-x")];
  const rows = pool.buildPoolRows(all, config, () => true);
  return new pool.PoolEditor(rows);
}

test("enabled queue stays on top and keeps saved order, missing models stay in place", () => {
  const editor = editorFixture({ enabled: ["anthropic/claude-x", "sub2/deepseek-flash"] });
  assert.deepEqual(
    editor.queue.map((row) => row.key),
    ["anthropic/claude-x", "sub2/deepseek-flash"],
  );
  assert.deepEqual(editor.rows.slice(0, 2).map((row) => row.key), ["anthropic/claude-x", "sub2/deepseek-flash"]);

  // 已保存但注册表中消失的模型：保留顺位并标记为不可用
  const missing = new pool.PoolEditor(
    pool.buildPoolRows([model("sub2", "deepseek-flash")], {
      version: 1,
      models: [{ provider: "ghost", modelId: "gone" }, { provider: "sub2", modelId: "deepseek-flash" }],
    }, () => true),
  );
  assert.equal(missing.rows[0].key, "ghost/gone");
  assert.equal(missing.rows[0].registered, false);
  assert.equal(missing.rows[0].available, false);
  assert.equal(missing.queue.length, 2);
});

test("space selects and unselects; arrows reorder only inside the enabled queue", () => {
  const editor = editorFixture({ enabled: ["anthropic/claude-x", "sub2/deepseek-flash", "openai-codex/gpt-5.6-luna"] });
  assert.equal(editor.cursor, 0);
  assert.equal(editor.toggleSelect(), true);
  assert.equal(editor.moving, true);
  assert.equal(editor.selectedKey, "anthropic/claude-x");

  // 在队列内向下移动一格：与第二项交换顺位
  assert.equal(editor.moveSelected(1), true);
  assert.deepEqual(editor.queue.map((row) => row.key), [
    "sub2/deepseek-flash",
    "anthropic/claude-x",
    "openai-codex/gpt-5.6-luna",
  ]);
  // 再向上移回顶部：合法交换
  assert.equal(editor.moveSelected(-1), true);
  assert.deepEqual(editor.queue.map((row) => row.key), [
    "anthropic/claude-x",
    "sub2/deepseek-flash",
    "openai-codex/gpt-5.6-luna",
  ]);
  // 已在队首继续向上：越界被拒绝，顺位不变
  assert.equal(editor.moveSelected(-1), false);
  assert.deepEqual(editor.queue.map((row) => row.key), [
    "anthropic/claude-x",
    "sub2/deepseek-flash",
    "openai-codex/gpt-5.6-luna",
  ]);

  // 空格取消选中
  assert.equal(editor.toggleSelect(), true);
  assert.equal(editor.moving, false);
  assert.equal(editor.selectedKey, null);
});

test("enter disables a model out of the queue and re-enables it at the tail", () => {
  const editor = editorFixture({ enabled: ["anthropic/claude-x", "sub2/deepseek-flash"] });
  assert.equal(editor.toggleEnabled(), true); // 停用 claude-x
  assert.deepEqual(editor.queue.map((row) => row.key), ["sub2/deepseek-flash"]);
  assert.equal(editor.rows.find((row) => row.key === "anthropic/claude-x").enabled, false);

  // 重新启用追加到队列末尾
  editor.search = "claude-x";
  editor.cursor = 0;
  assert.equal(editor.toggleEnabled(), true);
  assert.deepEqual(editor.queue.map((row) => row.key), ["sub2/deepseek-flash", "anthropic/claude-x"]);
  assert.deepEqual(editor.toConfig().models, [
    { provider: "sub2", modelId: "deepseek-flash" },
    { provider: "anthropic", modelId: "claude-x" },
  ]);
});

test("search filters rows, blocks reordering, and reset clears the filter", () => {
  const editor = editorFixture({ enabled: ["anthropic/claude-x"] });
  assert.equal(editor.appendSearch("luna"), true);
  assert.equal(editor.visibleRows.length, 1);
  assert.equal(editor.searching, true);
  editor.cursor = 0;
  assert.equal(editor.toggleSelect(), true);
  // 搜索状态下禁止排序
  assert.equal(editor.moveSelected(1), false);
  assert.equal(editor.backspaceSearch(), true);
  assert.equal(editor.backspaceSearch(), true);
  assert.equal(editor.backspaceSearch(), true);
  assert.equal(editor.backspaceSearch(), true);
  assert.equal(editor.search, "");
  assert.equal(editor.visibleRows.length, 3);
  assert.equal(editor.clearSearch(), false);
});

test("maps legacy and kitty key sequences to editor actions", () => {
  const cases = [
    ["\x1b[A", "up"],
    ["\x1bOA", "up"],
    ["\x1b[57419u", "up"],
    ["\x1b[B", "down"],
    ["\x1bOB", "down"],
    ["\x1b[57420u", "down"],
    ["\x1b[1;1A", "up"],
    ["\x1b[1;2B", "down"],
    [" ", "space"],
    ["\x1b[32u", "space"],
    ["\x1b[13;1u", "enter"],
    ["\x1b[27u", "escape"],
    ["\r", "enter"],
    ["\n", "enter"],
    ["\x1bOM", "enter"],
    ["\x1b", "escape"],
    ["\x13", "save"],
    ["\x7f", "backspace"],
    ["\x08", "backspace"],
  ];
  for (const [data, expected] of cases) {
    assert.equal(pool.poolKeyAction(data), expected, `key ${JSON.stringify(data)}`);
  }
  assert.equal(pool.poolKeyAction("\x1b[C"), undefined); // 左右键无意义
  assert.equal(pool.isPrintableInput("中文"), true);
  assert.equal(pool.isPrintableInput("\x1b[A"), false);
});

test("component renders queue numbers, scroll hints, and mode-specific key hints", () => {
  const editor = editorFixture({ enabled: ["anthropic/claude-x"] });
  const lines = pool.renderPoolLines(editor, 80);
  assert.match(lines[0], /压缩模型顺位池/);
  assert.match(lines[1], /启用 1/);
  assert.ok(lines.some((line) => /1 .*claude-x/.test(line)));
  assert.ok(lines.some((line) => line.includes("Ctrl+S")));

  editor.toggleSelect();
  const movingLines = pool.renderPoolLines(editor, 80);
  assert.ok(movingLines.some((line) => /调整顺位/.test(line)));

  // 长列表出现滚动提示
  const big = new pool.PoolEditor(
    pool.buildPoolRows(
      Array.from({ length: 40 }, (_, index) => model("p", `m${index}`)),
      { version: 1, models: [{ provider: "p", modelId: "m0" }] },
      () => true,
    ),
  );
  const scrolled = pool.renderPoolLines(big, 60, 5);
  assert.ok(scrolled.some((line) => /还有/.test(line)));
});

test("component routes keys to the editor and finishes on save/cancel", () => {
  const editor = editorFixture({ enabled: [] });
  const finishes = [];
  let renders = 0;
  const component = pool.createPoolEditorComponent({
    editor,
    requestRender: () => {
      renders += 1;
    },
    onDone: (result) => finishes.push(result),
  });
  component.handleInput("\r"); // 启用第一行
  assert.equal(renders, 1);
  assert.equal(editor.queue.length, 1);
  component.handleInput("\x13"); // Ctrl+S
  component.handleInput("\x1b"); // Esc
  assert.deepEqual(finishes, ["save", "cancel"]);
});

// ── 3. 历史快照 ─────────────────────────────────────────────────────────

const tagged = (ref, text, extra = {}) => ({
  role: extra.role ?? "user",
  id: extra.id,
  content: `<acp tokens="1.2K" type="text">${ref}</acp>\n${text}`,
});

function snapshotFixture() {
  return pool.createHistorySnapshot([
    tagged("m00010", "first user message", { id: "u10" }),
    { role: "assistant", id: "a11", content: "assistant reply one" },
    tagged("m00020", "second user message", { id: "u20" }),
    { role: "toolResult", id: "t21", content: [{ type: "text", text: "<acp tokens=\"0.4K\" type=\"bash\">m00021</acp>loose tag body" }] },
    tagged("m00030", "third user message", { id: "u30" }),
  ]);
}

test("snapshot parses tags, ids, and keeps them in ref order", () => {
  const snapshot = snapshotFixture();
  assert.equal(snapshot.refIndex.get("m00010"), 0);
  assert.equal(snapshot.refIndex.get("m00021"), 3);
  assert.equal(snapshot.idIndex.get("u20"), 2);
  assert.deepEqual(snapshot.refOrder.map((entry) => entry.ref), ["m00010", "m00020", "m00021", "m00030"]);
});

test("extracts an inclusive range and strips acp tags from the body", async () => {
  const snapshot = snapshotFixture();
  const result = pool.extractRangeText(snapshot, "m00010", "m00020");
  assert.equal(result.ok, true);
  assert.match(result.text, /first user message/);
  assert.match(result.text, /assistant reply one/);
  assert.match(result.text, /second user message/);
  assert.doesNotMatch(result.text, /<acp/);
  assert.deepEqual(result.refs, ["m00010", "m00020"]);
});

test("resolves assistant boundaries between tagged messages without guessing array positions", () => {
  const snapshot = snapshotFixture();
  // m00015 在快照里没有标签（assistant 不打标签），退化为「m00010 之后的下一条」
  const result = pool.extractRangeText(snapshot, "m00010", "m00021");
  assert.equal(result.ok, true);
  assert.match(result.text, /assistant reply one/);
  assert.match(result.text, /loose tag body/);
});

test("rejects inverted or unknown ranges with a short reason", () => {
  const snapshot = snapshotFixture();
  const inverted = pool.extractRangeText(snapshot, "m00030", "m00010");
  assert.equal(inverted.ok, false);
  assert.match(inverted.reason, /范围为空|顺序颠倒/);
  const unknown = pool.extractRangeText(snapshot, "nope", "m00030");
  assert.equal(unknown.ok, false);
  assert.match(unknown.reason, /引用格式无法识别/);
});

test("uses raw id mapping to locate boundaries that lost their tags", () => {
  const snapshot = pool.createHistorySnapshot([
    { role: "assistant", id: "a1", content: "no tag here" },
    tagged("m00040", "later", { id: "u40" }),
  ]);
  const withoutMap = pool.extractRangeText(snapshot, "m00035", "m00040");
  assert.equal(withoutMap.ok, true);
  assert.match(withoutMap.text, /no tag here/);
  const withMap = pool.extractRangeText(snapshot, "m00035", "m00040", {
    rawIdToRef: new Map([["m00035", "a1"]]),
  });
  assert.equal(withMap.ok, true);
  assert.match(withMap.text, /no tag here/);
});

test("supports block (bN) boundaries using the stored summary level", async () => {
  const dir = await tempDir("state");
  const stateFile = path.join(dir, "session.jsonl.acp.json");
  await fs.writeFile(
    stateFile,
    JSON.stringify({
      blocks: [
        {
          blockId: "b1",
          topic: "repo recon",
          summary: "BLOCK-SUMMARY-ONE",
          startRef: "m00010",
          endRef: "m00020",
          active: true,
        },
        { blockId: "b2", summary: "STALE", active: false },
      ],
      messageRefs: { byRef: { m00010: "u10" }, byRaw: { u10: "m00010" } },
    }),
    "utf8",
  );
  const state = await pool.readAcpStateSnapshot(stateFile);
  assert.equal(state.blocks.get("b1").summary, "BLOCK-SUMMARY-ONE");
  assert.equal(state.refToRawId.get("m00010"), "u10");
  assert.equal(state.rawIdToRef.get("u10"), "m00010");

  const snapshot = snapshotFixture();
  const blockResult = pool.extractRangeText(snapshot, "b1", "b1", { blocks: state.blocks });
  assert.equal(blockResult.ok, true);
  assert.match(blockResult.text, /BLOCK-SUMMARY-ONE/);
  assert.doesNotMatch(blockResult.text, /STALE/);

  const mixed = pool.extractRangeText(snapshot, "b1", "m00030", { blocks: state.blocks });
  assert.equal(mixed.ok, true);
  assert.match(mixed.text, /BLOCK-SUMMARY-ONE/);
  assert.match(mixed.text, /third user message/);

  const missing = pool.extractRangeText(snapshot, "b9", "b9", { blocks: state.blocks });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /未找到压缩块/);
});

test("readAcpStateSnapshot tolerates missing or broken files", async () => {
  const dir = await tempDir("state-broken");
  const missing = await pool.readAcpStateSnapshot(path.join(dir, "none.json"));
  assert.equal(missing.blocks.size, 0);
  const file = path.join(dir, "broken.json");
  await fs.writeFile(file, "not json", "utf8");
  const broken = await pool.readAcpStateSnapshot(file);
  assert.equal(broken.refToRawId.size, 0);
});

// ── 4. 摘要调用与降级 ───────────────────────────────────────────────────

test("returns the first candidate summary and records the attempt", async () => {
  const calls = [];
  const outcome = await pool.generateRangeSummary({
    range: { startId: "m1", endId: "m2" },
    body: "history body",
    maxChars: 1000,
    candidates: [
      { ref: { provider: "p1", modelId: "first" }, label: "first [p1]", model: model("p1", "first") },
      { ref: { provider: "p2", modelId: "second" }, label: "second [p2]", model: model("p2", "second") },
    ],
    complete: async (m, context, options) => {
      calls.push({ model: m.id, context, options });
      return assistantText("FIRST-SUMMARY");
    },
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.summary, "FIRST-SUMMARY");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "first");
  assert.deepEqual(outcome.attempts, [{ label: "first [p1]", ok: true, ms: outcome.attempts[0].ms }]);
});

test("falls back along the queue, then to the main model", async () => {
  const seen = [];
  const outcome = await pool.generateRangeSummary({
    range: { startId: "m1", endId: "m2" },
    body: "history body",
    maxChars: 1000,
    candidates: [
      { ref: { provider: "p1", modelId: "first" }, label: "first [p1]", model: model("p1", "first") },
      { ref: { provider: "p2", modelId: "second" }, label: "second [p2]", model: model("p2", "second") },
    ],
    fallback: { ref: { provider: "main", modelId: "m" }, label: "m [main]", model: model("main", "m") },
    complete: async (m) => {
      seen.push(m.id);
      if (m.id === "first") throw new Error("boom sk-abcdef123456");
      if (m.id === "second") return assistantText("");
      return assistantText("MAIN-SUMMARY");
    },
  });
  assert.deepEqual(seen, ["first", "second", "m"]);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.summary, "MAIN-SUMMARY");
  assert.equal(outcome.used, "m [main]");
  assert.equal(outcome.attempts[0].ok, false);
  assert.doesNotMatch(outcome.attempts[0].reason, /sk-abcdef/); // 失败原因已脱敏
  assert.match(outcome.attempts[1].reason, /空摘要/);
});

test("does not re-request the main model when the pool already tried it", async () => {
  const seen = [];
  const outcome = await pool.generateRangeSummary({
    range: { startId: "m1", endId: "m2" },
    body: "body",
    maxChars: 1000,
    candidates: [{ ref: { provider: "sub2", modelId: "main" }, label: "main [sub2]", model: model("sub2", "main") }],
    fallback: { ref: { provider: "sub2", modelId: "main" }, label: "main [sub2]", model: model("sub2", "main") },
    complete: async (m) => {
      seen.push(m.id);
      throw new Error("pool down");
    },
  });
  assert.deepEqual(seen, ["main"]);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.cancelled, false);
  assert.match(outcome.reason, /pool down/);
});

test("skips candidates whose context window is too small and reports it", async () => {
  const seen = [];
  const outcome = await pool.generateRangeSummary({
    range: { startId: "m1", endId: "m2" },
    body: "x".repeat(2000),
    maxChars: 1000,
    candidates: [
      { ref: { provider: "tiny", modelId: "tiny" }, label: "tiny [tiny]", model: model("tiny", "tiny", { contextWindow: 1000 }) },
      { ref: { provider: "big", modelId: "big" }, label: "big [big]", model: model("big", "big") },
    ],
    complete: async (m) => {
      seen.push(m.id);
      return assistantText("OK");
    },
  });
  assert.deepEqual(seen, ["big"]);
  assert.equal(outcome.ok, true);
  assert.match(outcome.attempts[0].reason, /容量不足/);
});

test("treats a timeout as a candidate failure and moves on", async () => {
  const outcome = await pool.generateRangeSummary({
    range: { startId: "m1", endId: "m2" },
    body: "body",
    maxChars: 1000,
    timeoutMs: 20,
    candidates: [
      { ref: { provider: "slow", modelId: "slow" }, label: "slow [slow]", model: model("slow", "slow") },
      { ref: { provider: "fast", modelId: "fast" }, label: "fast [fast]", model: model("fast", "fast") },
    ],
    complete: (m, _context, options) =>
      m.id === "slow"
        ? new Promise((_resolve, reject) => {
            options.signal.addEventListener("abort", () => reject(new Error("aborted")));
          })
        : Promise.resolve(assistantText("FAST")),
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.summary, "FAST");
  assert.match(outcome.attempts[0].reason, /超时/);
});

test("rejects over-length summaries instead of truncating them", async () => {
  const outcome = await pool.generateRangeSummary({
    range: { startId: "m1", endId: "m2" },
    body: "body",
    maxChars: 10,
    candidates: [{ ref: { provider: "p", modelId: "m" }, label: "m [p]", model: model("p", "m") }],
    complete: async () => assistantText("this summary is far too long"),
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /超出长度限制/);
});

test("stops immediately when the user cancels", async () => {
  const controller = new AbortController();
  let calls = 0;
  const outcome = await pool.generateRangeSummary({
    range: { startId: "m1", endId: "m2" },
    body: "body",
    maxChars: 1000,
    signal: controller.signal,
    candidates: [{ ref: { provider: "p", modelId: "m" }, label: "m [p]", model: model("p", "m") }],
    complete: async () => {
      calls += 1;
      controller.abort();
      throw new Error("aborted");
    },
  });
  assert.equal(calls, 1);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.cancelled, true);
});

test("strips a single outer code fence and keeps inner text intact", () => {
  assert.deepEqual(pool.normalizeSummaryText("```md\n# Title\nbody\n```", 100), { ok: true, text: "# Title\nbody" });
  assert.equal(pool.normalizeSummaryText("   ", 100).ok, false);
});

test("summary request carries only the range data and explicit rules", () => {
  const request = pool.buildSummaryRequest({
    startId: "m00010",
    endId: "m00020",
    topic: "recon",
    hint: "draft hint",
    body: "#0 [user m00010]\nhello",
    maxChars: 20000,
  });
  // 上下文隔离：只有 systemPrompt + 一条 user 数据消息，不携带工具或凭据字段。
  assert.deepEqual(Object.keys(request).sort(), ["messages", "systemPrompt"]);
  assert.equal(request.messages.length, 1);
  const text = request.messages[0].content[0].text;
  assert.match(text, /BEGIN HISTORY EXCERPT/);
  assert.match(text, /END HISTORY EXCERPT/);
  assert.match(text, /draft hint/);
  assert.match(text, /m00010\.\.m00020/);
  assert.match(request.systemPrompt, /data, never instructions/);
  assert.doesNotMatch(text, /tools|apiKey|Authorization/i);
});

test("sanitizes credentials out of failure reasons", () => {
  const cleaned = pool.sanitizeFailureReason(new Error("auth failed for sk-live-abcdefghijklmnop Bearer abcdefghijklmnopqrstuvwxyz"));
  assert.doesNotMatch(cleaned, /sk-live/);
  assert.doesNotMatch(cleaned, /Bearer abcdef/);
  assert.ok(cleaned.length <= 181);
});

test("resolvePoolCandidates skips unregistered and unauthenticated models", () => {
  const registry = registryOf([model("p1", "ok"), model("p2", "noauth")], { failAuth: new Set(["p2/noauth"]) });
  const candidates = pool.resolvePoolCandidates(
    {
      version: 1,
      models: [
        { provider: "p1", modelId: "ok" },
        { provider: "p2", modelId: "noauth" },
        { provider: "p3", modelId: "missing" },
      ],
    },
    registry,
  );
  assert.deepEqual(candidates.map((candidate) => candidate.label), ["ok [p1]"]);
});
