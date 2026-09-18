// compress 包装层与 /acp-models 的集成测试：
//   1) 工具面与 schema（summary 变为可选）；
//   2) context 快照捕获 → 模型池摘要 → 原压缩引擎；
//   3) 空池/失败/取消/快照变化等降级路径；
//   4) 命令保存、放弃、损坏配置保护，以及提供者请求的上下文隔离。
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createJiti } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const extensionModule = await jiti.import("../index.ts");
const { createLeanAcpExtension } = extensionModule;

async function tempDir(label) {
  return fs.mkdtemp(path.join(tmpdir(), `acp-pool-int-${label}-`));
}

/** 在指定临时目录内运行，隔离全局进程环境。 */
async function withAgentDir(label, run) {
  const dir = await tempDir(label);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    return await run(dir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
}

function model(provider, id, extra = {}) {
  return { provider, id, name: id, contextWindow: 200_000, ...extra };
}

function assistantText(text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    timestamp: Date.now(),
  };
}

function createPi() {
  const tools = [];
  const handlers = new Map();
  const commands = new Map();
  const noOp = () => undefined;
  return new Proxy({
    tools,
    handlers,
    commands,
    registerTool(tool) {
      tools.push(tool);
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
    on(event, handler) {
      const listeners = handlers.get(event) ?? [];
      listeners.push(handler);
      handlers.set(event, listeners);
    },
    registerShortcut: noOp,
    registerMessageRenderer: noOp,
    registerProvider: noOp,
    registerFlag: noOp,
    getFlag: () => undefined,
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: noOp,
    appendEntry: noOp,
    sendMessage: noOp,
    events: { on: noOp, emit: noOp },
  }, {
    get(target, property) {
      return property in target ? target[property] : noOp;
    },
  });
}

/** 上游 compress 的真实 schema 形状：content 是 Array|String 联合，summary 必填。 */
function compressSchema() {
  return {
    type: "object",
    description: "outer description",
    properties: {
      topic: { type: "string" },
      content: {
        anyOf: [
          {
            type: "array",
            items: {
              type: "object",
              properties: {
                startId: { type: "string", description: "large start description" },
                endId: { type: "string", description: "large end description" },
                summary: { type: "string", description: "large summary description" },
                topic: { type: "string", description: "large topic description" },
              },
              required: ["startId", "endId", "summary"],
            },
          },
          { type: "string" },
        ],
      },
      summaryMaxChars: { type: "number" },
    },
    required: ["content"],
  };
}

function fakeUpstream({ upstreamCalls, contextMessages }) {
  return (pi) => {
    pi.registerTool({
      name: "compress",
      label: "Compress",
      description: "upstream compress",
      parameters: compressSchema(),
      async execute(_callId, params) {
        upstreamCalls.push(params);
        return { content: [{ type: "text", text: "compressed ok" }], details: undefined };
      },
    });
    pi.on("context", async () => ({ messages: contextMessages() }));
    pi.on("before_agent_start", () => ({ systemPrompt: "upstream prompt" }));
  };
}

const tagged = (ref, text, id) => ({
  role: "user",
  id,
  content: `<acp tokens="1.2K" type="text">${ref}</acp>\n${text}`,
});

function contextMessages() {
  return [
    tagged("m00010", "first body", "u10"),
    { role: "assistant", id: "a11", content: "assistant body" },
    tagged("m00020", "second body", "u20"),
  ];
}

function makeCtx({ sessionId = "s1", sessionFile, models, mainModel, complete, ui }) {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => sessionFile,
    },
    modelRegistry: {
      getAll: () => models,
      find: (provider, modelId) => models.find((m) => m.provider === provider && m.id === modelId),
      hasConfiguredAuth: () => true,
      complete,
    },
    model: mainModel,
    ui: ui ?? { notify() {}, custom: async () => "cancel" },
  };
}

async function writeConfig(dir, models) {
  await fs.writeFile(
    path.join(dir, "compress-models.json"),
    JSON.stringify({ version: 1, models }, null, 2),
    "utf8",
  );
}

function build({ dir, upstreamCalls, contextMessages: messages, complete }) {
  const pi = createPi();
  createLeanAcpExtension(fakeUpstream({ upstreamCalls, contextMessages: messages ?? contextMessages }))(pi);
  const ctx = makeCtx({
    models: [model("pool", "summarizer"), model("main", "main-model")],
    mainModel: model("main", "main-model"),
    sessionFile: path.join(dir, "session.jsonl"),
    complete,
  });
  return { pi, ctx };
}

/** 先跑一次 context 事件，填充只读快照。 */
async function primeSnapshot(pi, ctx) {
  const handlers = pi.handlers.get("context");
  await handlers[0]({ messages: contextMessages() }, ctx);
}

function compressTool(pi) {
  return pi.tools.find((tool) => tool.name === "compress");
}

test("registers compress, acp_context, and the /acp-models command", async () => {
  await withAgentDir("surface", async (dir) => {
    const { pi } = build({ dir, upstreamCalls: [] });
    assert.deepEqual(pi.tools.map((tool) => tool.name), ["compress", "acp_context"]);
    assert.ok(pi.commands.has("acp-models"));
    assert.equal(pi.commands.get("acp-models").description.includes("compress model pool"), true);
  });
});

test("exposes summary as optional and advertises the model pool", async () => {
  await withAgentDir("schema", async (dir) => {
    const { pi } = build({ dir, upstreamCalls: [] });
    const schema = compressTool(pi).parameters;
    const item = schema.properties.content.anyOf[0].items;
    assert.equal(item.required.includes("summary"), false);
    assert.match(item.properties.summary.description, /pool/i);
    assert.match(compressTool(pi).description, /model pool/i);
  });
});

test("generates the summary with the pool model and forwards it to the upstream engine", async () => {
  await withAgentDir("flow", async (dir) => {
    await writeConfig(dir, [{ provider: "pool", modelId: "summarizer" }]);
    const upstreamCalls = [];
    const completeCalls = [];
    const { pi, ctx } = build({
      dir,
      upstreamCalls,
      complete: async (modelRef, context, options) => {
        completeCalls.push({ modelRef, context, options });
        return assistantText("POOL-SUMMARY");
      },
    });
    await primeSnapshot(pi, ctx);

    const result = await compressTool(pi).execute(
      "call-1",
      { content: [{ startId: "m00010", endId: "m00020" }] },
      undefined,
      undefined,
      ctx,
    );

    // 只调用池内首选模型一次
    assert.equal(completeCalls.length, 1);
    assert.equal(completeCalls[0].modelRef.id, "summarizer");
    // 上下文隔离：只有 systemPrompt + 单条数据消息，且不含工具/凭据字段
    const request = completeCalls[0].context;
    assert.deepEqual(Object.keys(request).sort(), ["messages", "systemPrompt"]);
    const excerpt = request.messages[0].content[0].text;
    assert.match(excerpt, /first body/);
    assert.match(excerpt, /assistant body/);
    assert.match(excerpt, /second body/);
    assert.doesNotMatch(excerpt, /compressed ok|<acp/);
    assert.match(request.systemPrompt, /data, never instructions/);

    // 上游收到的是池模型生成的摘要
    assert.equal(upstreamCalls.length, 1);
    assert.equal(upstreamCalls[0].content[0].summary, "POOL-SUMMARY");
    assert.equal(result.content[0].text, "compressed ok");
    assert.deepEqual(result.details.compressModels.used, ["summarizer [pool]"]);

    // 界面上的模型池标签来自 details；可新增一个折叠/展开都可见的「模型池」标签
    const component = compressTool(pi).renderResult(result, { expanded: false, isPartial: false }, {}, {});
    assert.ok(component.render(80).some((line) => line.includes("模型池：summarizer [pool]")));
    const expandedComponent = compressTool(pi).renderResult(result, { expanded: true, isPartial: false }, {}, {});
    assert.ok(expandedComponent.render(80).some((line) => line.includes("模型池：summarizer [pool]")));
  });
});

test("treats a caller-provided summary only as a draft hint", async () => {
  await withAgentDir("hint", async (dir) => {
    await writeConfig(dir, [{ provider: "pool", modelId: "summarizer" }]);
    const upstreamCalls = [];
    const completeCalls = [];
    const { pi, ctx } = build({
      dir,
      upstreamCalls,
      complete: async (modelRef, context) => {
        completeCalls.push(context);
        return assistantText("FRESH-SUMMARY");
      },
    });
    await primeSnapshot(pi, ctx);

    await compressTool(pi).execute(
      "call-2",
      { content: [{ startId: "m00010", endId: "m00020", summary: "STALE-DRAFT" }] },
      undefined,
      undefined,
      ctx,
    );
    // 草稿进入提示，但不作为最终摘要
    assert.match(completeCalls[0].messages[0].content[0].text, /STALE-DRAFT/);
    assert.match(completeCalls[0].messages[0].content[0].text, /authoritative/);
    assert.equal(upstreamCalls[0].content[0].summary, "FRESH-SUMMARY");
  });
});

test("falls back to the session main model when the pool is empty", async () => {
  await withAgentDir("empty-pool", async (dir) => {
    const upstreamCalls = [];
    const completeCalls = [];
    const { pi, ctx } = build({
      dir,
      upstreamCalls,
      complete: async (modelRef) => {
        completeCalls.push(modelRef.id);
        return assistantText("MAIN-SUMMARY");
      },
    });
    await primeSnapshot(pi, ctx);
    const result = await compressTool(pi).execute(
      "call-3",
      { content: [{ startId: "m00010", endId: "m00020" }] },
      undefined,
      undefined,
      ctx,
    );
    assert.deepEqual(completeCalls, ["main-model"]);
    assert.equal(upstreamCalls[0].content[0].summary, "MAIN-SUMMARY");
    assert.deepEqual(result.details.compressModels.used, ["main-model [main]"]);
  });
});

test("keeps history untouched when every candidate fails", async () => {
  await withAgentDir("all-fail", async (dir) => {
    await writeConfig(dir, [{ provider: "pool", modelId: "summarizer" }]);
    const upstreamCalls = [];
    const completeCalls = [];
    const { pi, ctx } = build({
      dir,
      upstreamCalls,
      complete: async (modelRef) => {
        completeCalls.push(modelRef.id);
        throw new Error("provider down");
      },
    });
    await primeSnapshot(pi, ctx);
    const result = await compressTool(pi).execute(
      "call-4",
      { content: [{ startId: "m00010", endId: "m00020" }] },
      undefined,
      undefined,
      ctx,
    );
    assert.deepEqual(completeCalls, ["summarizer", "main-model"]); // 池失败后回退主模型
    assert.match(result.content[0].text, /摘要生成失败.*历史未修改/);
    assert.equal(upstreamCalls.length, 0);
    assert.equal(result.details.compressModels.attempts.length, 2);
  });
});

test("fails fast without a snapshot and never calls the upstream engine", async () => {
  await withAgentDir("no-snapshot", async (dir) => {
    const upstreamCalls = [];
    let completeCalls = 0;
    const { pi, ctx } = build({
      dir,
      upstreamCalls,
      complete: async () => {
        completeCalls += 1;
        return assistantText("never");
      },
    });
    const result = await compressTool(pi).execute(
      "call-5",
      { content: [{ startId: "m00010", endId: "m00020" }] },
      undefined,
      undefined,
      ctx,
    );
    assert.match(result.content[0].text, /还没有 ACP 上下文快照/);
    assert.equal(completeCalls, 0);
    assert.equal(upstreamCalls.length, 0);
  });
});

test("stops on user cancellation without treating it as a model failure", async () => {
  await withAgentDir("cancel", async (dir) => {
    await writeConfig(dir, [{ provider: "pool", modelId: "summarizer" }]);
    const upstreamCalls = [];
    let completeCalls = 0;
    const { pi, ctx } = build({
      dir,
      upstreamCalls,
      complete: async () => {
        completeCalls += 1;
        return assistantText("never");
      },
    });
    await primeSnapshot(pi, ctx);
    const controller = new AbortController();
    controller.abort();
    const result = await compressTool(pi).execute(
      "call-6",
      { content: [{ startId: "m00010", endId: "m00020" }] },
      controller.signal,
      undefined,
      ctx,
    );
    assert.match(result.content[0].text, /compress 已取消/);
    assert.equal(completeCalls, 0);
    assert.equal(upstreamCalls.length, 0);
  });
});

test("abandons the commit when the snapshot changes during generation", async () => {
  await withAgentDir("stale", async (dir) => {
    await writeConfig(dir, [{ provider: "pool", modelId: "summarizer" }]);
    const upstreamCalls = [];
    const { pi, ctx } = build({
      dir,
      upstreamCalls,
      complete: async () => {
        // 生成期间触发一次新的 context（模拟分支切换/并发压缩）
        await primeSnapshot(pi, ctx);
        return assistantText("POOL-SUMMARY");
      },
    });
    await primeSnapshot(pi, ctx);
    const result = await compressTool(pi).execute(
      "call-7",
      { content: [{ startId: "m00010", endId: "m00020" }] },
      undefined,
      undefined,
      ctx,
    );
    assert.match(result.content[0].text, /摘要生成期间发生变化/);
    assert.equal(upstreamCalls.length, 0);
  });
});

test("rejects malformed ranges with a short receipt", async () => {
  await withAgentDir("malformed", async (dir) => {
    const { pi, ctx } = build({ dir, upstreamCalls: [] });
    await primeSnapshot(pi, ctx);
    const result = await compressTool(pi).execute(
      "call-8",
      { content: [{ startId: "m00010" }] },
      undefined,
      undefined,
      ctx,
    );
    assert.match(result.content[0].text, /缺少 startId\/endId/);
  });
});

test("accepts the JSON-encoded content form from non-strict providers", async () => {
  await withAgentDir("string-content", async (dir) => {
    await writeConfig(dir, [{ provider: "pool", modelId: "summarizer" }]);
    const upstreamCalls = [];
    const { pi, ctx } = build({
      dir,
      upstreamCalls,
      complete: async () => assistantText("POOL-SUMMARY"),
    });
    await primeSnapshot(pi, ctx);
    await compressTool(pi).execute(
      "call-9",
      { content: JSON.stringify([{ startId: "m00010", endId: "m00020" }]) },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(upstreamCalls[0].content[0].summary, "POOL-SUMMARY");
  });
});

// ── /acp-models 命令 ────────────────────────────────────────────────────

function commandCtx({ keys, onCustom, models, hasAuth, onRendered }) {
  const notifications = [];
  const poolModels = models ?? [model("pool", "summarizer"), model("main", "main-model")];
  const ctx = {
    ui: {
      notify(message, type) {
        notifications.push([message, type]);
      },
      custom(factory) {
        return new Promise((resolve) => {
          const done = (result) => resolve(result);
          const component = factory({ requestRender() {} }, {}, {}, done);
          // 逐个投递按键，并在每个按键后让出事件循环，
          // 这样界面内的异步保存（失败/成功）才有机会真正执行。
          // 按键可以是字符串，也可以是 { key, when }：先等到 when 成立再投递，
          // 用于验证「写入失败后仍停在界面、用户随后按 Esc 才关闭」。
          void (async () => {
            await onCustom?.(component);
            onRendered?.(component.render(100));
            for (const entry of keys) {
              const spec = typeof entry === "string" ? { key: entry } : entry;
              if (spec.when) await spec.when(component);
              component.handleInput(spec.key);
              await new Promise((next) => setTimeout(next, 0));
            }
          })();
        });
      },
    },
    modelRegistry: {
      getAll: () => poolModels,
      find: (provider, modelId) => poolModels.find((m) => m.provider === provider && m.id === modelId),
      hasConfiguredAuth: (m) => (hasAuth ? hasAuth(m) : true),
      complete: async () => assistantText("x"),
    },
    sessionManager: { getSessionId: () => "s1", getSessionFile: () => undefined },
  };
  return { ctx, notifications };
}

/** 轮询界面渲染结果，直到出现指定文案（用于等待异步保存真正结束）。 */
async function waitForRender(component, needle, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (component.render(100).some((line) => line.includes(needle))) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`等待界面出现「${needle}」超时`);
}

test("/acp-models saves the ranked queue on Ctrl+S", async () => {
  await withAgentDir("cmd-save", async (dir) => {
    const { ctx, notifications } = commandCtx({ keys: ["\r", "\x13"] });
    const pi = createPi();
    createLeanAcpExtension(fakeUpstream({ upstreamCalls: [], contextMessages }))(pi);
    await pi.commands.get("acp-models").handler("", ctx);
    const saved = JSON.parse(await fs.readFile(path.join(dir, "compress-models.json"), "utf8"));
    // 空配置下光标在第一行（summarizer [pool]），回车启用后追加到队列
    assert.deepEqual(saved.models, [{ provider: "pool", modelId: "summarizer" }]);
    assert.ok(notifications.some(([message]) => /已保存 1 个模型的顺位/.test(message)));
  });
});

test("/acp-models keeps the file untouched when the user cancels", async () => {
  await withAgentDir("cmd-cancel", async (dir) => {
    const { ctx, notifications } = commandCtx({ keys: ["\r", "\x1b"] });
    const pi = createPi();
    createLeanAcpExtension(fakeUpstream({ upstreamCalls: [], contextMessages }))(pi);
    await pi.commands.get("acp-models").handler("", ctx);
    await assert.rejects(fs.readFile(path.join(dir, "compress-models.json"), "utf8"));
    assert.ok(notifications.some(([message]) => /已放弃本次修改/.test(message)));
  });
});

test("/acp-models refuses to open (and never overwrites) a corrupt config", async () => {
  await withAgentDir("cmd-corrupt", async (dir) => {
    await fs.writeFile(path.join(dir, "compress-models.json"), "{ broken", "utf8");
    let customCalls = 0;
    const { ctx, notifications } = commandCtx({ keys: ["\x13"], onCustom: () => (customCalls += 1) });
    const pi = createPi();
    createLeanAcpExtension(fakeUpstream({ upstreamCalls: [], contextMessages }))(pi);
    await pi.commands.get("acp-models").handler("", ctx);
    assert.equal(customCalls, 0);
    assert.equal(await fs.readFile(path.join(dir, "compress-models.json"), "utf8"), "{ broken");
    assert.ok(notifications.some(([, type]) => type === "error"));
  });
});

test("/acp-models lists only authenticated models and keeps hidden saved entries", async () => {
  await withAgentDir("cmd-filter", async (dir) => {
    // 已保存的 ghost/gone 当前未配置认证，必须在界面上隐藏但保留在配置里
    await writeConfig(dir, [
      { provider: "ghost", modelId: "gone" },
      { provider: "pool", modelId: "summarizer" },
    ]);
    const renders = [];
    const { ctx } = commandCtx({
      keys: ["\x1b"],
      models: [model("ghost", "gone"), model("pool", "summarizer"), model("main", "main-model")],
      hasAuth: (m) => m.provider !== "ghost",
      onRendered: (lines) => renders.push(lines),
    });
    const pi = createPi();
    createLeanAcpExtension(fakeUpstream({ upstreamCalls: [], contextMessages }))(pi);
    await pi.commands.get("acp-models").handler("", ctx);

    const screen = renders.at(-1).join("\n");
    assert.match(screen, /summarizer\s+\[pool\]/, screen);
    assert.ok(!screen.includes("ghost/gone")); // 不可用模型不生成列表行
    assert.ok(!/[✓×]/.test(screen)); // 不再出现可用性标记
    assert.ok(screen.includes("已保留 1 个当前不可用配置"));
  });
});

test("/acp-models keeps the panel open after a failed write and lands the draft on the next run", async () => {
  await withAgentDir("cmd-save-fail", async (dir) => {
    const file = path.join(dir, "compress-models.json");
    await writeConfig(dir, [{ provider: "pool", modelId: "summarizer" }]);
    const { ctx, notifications } = commandCtx({
      keys: [
        "\r",
        "\x13",
        // 写失败时界面必须停在原处：等到「保存失败」出现后再按 Esc 放弃
        { key: "\x1b", when: (component) => waitForRender(component, "保存失败") },
      ],
      // 界面打开后（配置已读取）把目标位置换成同名目录，让原子替换必然失败
      onCustom: async () => {
        await fs.rm(file, { force: true });
        await fs.mkdir(file, { recursive: true });
      },
    });
    const pi = createPi();
    createLeanAcpExtension(fakeUpstream({ upstreamCalls: [], contextMessages }))(pi);
    await pi.commands.get("acp-models").handler("", ctx);
    assert.ok((await fs.stat(file)).isDirectory()); // 目录未被覆盖
    assert.ok(!notifications.some(([message]) => /已保存/.test(message))); // 不谎报成功
    assert.ok(notifications.some(([message]) => /已放弃本次修改/.test(message)), JSON.stringify(notifications)); // Esc 后才关闭

    // 失败时保留的草稿会在下一次打开时恢复（不写入、不重排原配置）
    await fs.rmdir(file);
    const second = commandCtx({ keys: ["\x1b"] });
    await pi.commands.get("acp-models").handler("", second.ctx);
    assert.ok(second.notifications.some(([message]) => /已恢复上次未保存的草稿/.test(message)));
    await assert.rejects(fs.stat(file));
  });
});

test("normal compress flow stays short and does not leak pool internals into content", async () => {
  await withAgentDir("receipt", async (dir) => {
    await writeConfig(dir, [{ provider: "pool", modelId: "summarizer" }]);
    const completeCalls = [];
    const { pi, ctx } = build({
      dir,
      upstreamCalls: [],
      complete: async (_modelRef, context) => {
        completeCalls.push(context);
        return assistantText("POOL-SUMMARY");
      },
    });
    await primeSnapshot(pi, ctx);
    const result = await compressTool(pi).execute(
      "call-10",
      { content: [{ startId: "m00010", endId: "m00020" }] },
      undefined,
      undefined,
      ctx,
    );
    // 回执保持简短：上游文本 + 一个 details 标签，不包含摘要正文或降级日志
    assert.equal(result.content.length, 1);
    assert.doesNotMatch(result.content[0].text, /POOL-SUMMARY/);
    assert.doesNotMatch(JSON.stringify(result.content), /compress-models\.json|sk-/);
    // 下一次主模型请求不会被内部摘要对话污染（这里以“摘要请求只含数据消息”作为快照证明）
    assert.equal(completeCalls.length, 1);
    assert.equal(completeCalls[0].messages.length, 1);
  });
});
