// Dedicated summary model (#241 port onto v0.1.83): `/acp compact` config and
// the compress-tool routing through Pi's model registry (ctx.modelRegistry).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAcpExtension } from "../src/index.js";
import { detectPlanningLeak, detectTranscriptEcho, fitToModel, resolveModel } from "../src/compress-model.js";

function captureApi() {
  const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
  const api = {
    on(event: string, handler: (e: any, ctx: any) => any) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    tools: [] as any[],
    commands: new Map<string, any>(),
    registerTool(tool: any) { this.tools.push(tool); },
    registerCommand(name: string, options: any) { this.commands.set(name, options); },
    getActiveTools: () => ["read", "compress"],
    getAllTools: () => [
      { name: "read", description: "Read a file", parameters: { type: "object" } },
      { name: "compress", description: "Compress", parameters: { type: "object" } },
      { name: "write", description: "inactive", parameters: { type: "object" } },
    ],
  };
  return { api, handlers };
}

function userMsg(id: string, text: string) {
  return { type: "message", id, parentId: null, timestamp: "", message: { role: "user", content: text, timestamp: Date.now() } };
}

type Call = { model: any; context: any; options: any };

function model(provider: string, id: string): any {
  return { provider, id, name: id, api: "openai-completions", contextWindow: 200_000, maxTokens: 8000 };
}

/** Registry fake: Pi >= 1.x shape (find/getAll/complete). */
function fakeRegistry(models: any[], reply: (call: Call) => Promise<any>, calls: Call[]) {
  return {
    getAll: () => models,
    find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
    complete: async (m: any, context: any, options: any) => {
      const call = { model: m, context, options };
      calls.push(call);
      return reply(call);
    },
  };
}

function textReply(text: string) {
  return async () => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" });
}

function fakeCtx(entries: any[], stateFile: string, cwd: string, registry: any, onNotify?: (s: string) => void, sessionModel?: any) {
  return {
    mode: "rpc",
    hasUI: false,
    cwd,
    ui: { notify: (s: string) => onNotify?.(s), confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: sessionModel ?? { contextWindow: 200_000, id: "test-model", provider: "mainprov" },
    modelRegistry: registry,
    getContextUsage: () => null,
    getSystemPrompt: () => "SESSION SYSTEM PROMPT",
    sessionManager: {
      buildContextEntries: () => entries,
      getSessionId: () => "test-session",
      getSessionFile: () => stateFile,
    },
  };
}

// Oldest message must clear minCompressRange and sit outside the protected tail.
const LONG = "lorem ipsum dolor sit amet ".repeat(400);
const FILLER = "filler text for padding purposes ".repeat(150);
function compressibleEntries(): any[] {
  const out = [userMsg("e1", LONG)];
  for (let i = 2; i <= 7; i++) out.push(userMsg(`e${i}`, FILLER));
  return out;
}

async function readBlockSummaries(stateFile: string): Promise<string[]> {
  const state = JSON.parse(await fs.readFile(`${stateFile}.acp.json`, "utf8"));
  return (state.blocks ?? []).map((b: { summary: string }) => b.summary);
}

const DEDICATED = "DEDICATED-SUMMARY: the dedicated summary model wrote this replacement for the range.";
const FALLBACK = "Caller fallback summary: lorem ipsum exploration finished; nothing pending in this range.";

let tmp: string;
let acpJsonPath: string;
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acp-compress-model-"));
  // os.homedir() reads USERPROFILE on Windows, HOME elsewhere — set both.
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  acpJsonPath = path.join(tmp, ".pi", "acp.json");
});

after(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await fs.rm(tmp, { recursive: true, force: true });
});

async function setup(name: string, registry: any, opts: { acpJson?: object; sessionModel?: any; notify?: (s: string) => void; entries?: any[] } = {}) {
  await fs.rm(acpJsonPath, { force: true });
  if (opts.acpJson) {
    await fs.mkdir(path.dirname(acpJsonPath), { recursive: true });
    await fs.writeFile(acpJsonPath, JSON.stringify(opts.acpJson));
  }
  const { api, handlers } = captureApi();
  createAcpExtension({})(api as any);
  const stateFile = path.join(tmp, `${name}.session.json`);
  await fs.rm(`${stateFile}.acp.json`, { force: true });
  const ctx = fakeCtx(opts.entries ?? compressibleEntries(), stateFile, tmp, registry, opts.notify, opts.sessionModel);
  for (const h of handlers.get("session_start") ?? []) await h({ type: "session_start" }, ctx);
  await handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);
  const compress = api.tools.find((t: any) => t.name === "compress")!;
  const run = async (summary: string) => {
    const out = await compress.execute("tc1", { content: [{ startId: "m00001", endId: "m00001", summary }] }, undefined, undefined, ctx);
    return out.content?.[0]?.text ?? String(out);
  };
  return { api, handlers, ctx, stateFile, compress, run };
}

test("resolveModel: provider/id, unique bare id, ambiguous bare id, unknown", () => {
  const reg = fakeRegistry([model("a", "x"), model("b", "x"), model("a", "only"), model("p", "org/model")], textReply(""), []);
  assert.equal(resolveModel(reg as any, "a/x").model?.provider, "a");
  assert.equal(resolveModel(reg as any, "only").model?.provider, "a");
  assert.equal(resolveModel(reg as any, "p/org/model").model?.id, "org/model");
  const amb = resolveModel(reg as any, "x");
  assert.equal(amb.model, null);
  assert.deepEqual(amb.ambiguous.map((m) => m.provider).sort(), ["a", "b"]);
  assert.deepEqual(resolveModel(reg as any, "nope"), { model: null, ambiguous: [] });
});

test("compress: registry model writes the summary from the extracted range", async () => {
  const calls: Call[] = [];
  const registry = fakeRegistry([model("cheap", "summarizer")], textReply(DEDICATED), calls);
  const { run, stateFile, compress } = await setup("dedicated", registry, { acpJson: { compressionModelId: "cheap/summarizer" } });
  assert.match(compress.description, /Dedicated summary model cheap\/summarizer/);
  const text = await run(FALLBACK);
  assert.match(text, /summaries written by cheap\/summarizer \(1\/1\)/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.model.id, "summarizer");
  const prompt = JSON.stringify(calls[0]!.context.messages);
  assert.ok(prompt.includes("lorem ipsum"), "range transcript must be sent");
  assert.ok(!prompt.includes("filler text"), "only the requested range is extracted");
  assert.ok(calls[0]!.options.maxTokens >= 256);
  const summaries = await readBlockSummaries(stateFile);
  assert.ok(summaries.includes(DEDICATED), JSON.stringify(summaries));
  assert.ok(!summaries.includes(FALLBACK));
});

test("compress: refolding over an active block sends its summary, not the raw messages", async () => {
  const calls: Call[] = [];
  const registry = fakeRegistry([model("cheap", "summarizer")], textReply(DEDICATED), calls);
  const { ctx, compress, run } = await setup("refold", registry, { acpJson: { compressionModelId: "cheap/summarizer" } });
  await run(FALLBACK);
  const text = (await compress.execute("tc2", { content: [{ startId: "b1", endId: "m00002", summary: FALLBACK }] }, undefined, undefined, ctx)).content?.[0]?.text;
  assert.match(String(text), /summaries written by cheap\/summarizer \(1\/1\)/);
  assert.equal(calls.length, 2);
  const prompt = JSON.stringify(calls[1]!.context.messages);
  assert.ok(prompt.includes("[earlier summary b1"), prompt.slice(0, 400));
  assert.ok(prompt.includes("DEDICATED-SUMMARY"), "the block summary stands in for its messages");
  // "lorem ipsum dolor" is b1's raw text; FALLBACK (now sent as the caller note) says "lorem ipsum exploration".
  assert.ok(!prompt.includes("lorem ipsum dolor"), "raw messages already folded into b1 are not resent");
  assert.ok(prompt.includes("filler text"), "new messages in the range are sent raw");
  assert.match(calls[1]!.context.systemPrompt, /CARRY FORWARD/);
});

for (const facade of [false, true]) for (const mixed of [false, true]) for (const shape of ["single", "adjacent"]) test(`dedicated inline refold survives log-only recovery (facade=${facade}, mixed=${mixed}, shape=${shape})`, async () => {
  let revision = 0;
  const registry = fakeRegistry([model("cheap", "summarizer")], async () => ({
    role: "assistant", content: [{ type: "text", text: `${DEDICATED} revision ${++revision}` }], stopReason: "stop",
  }), []);
  // Three eligible messages must remain outside the five-message tail even
  // after two of them are folded, so a mixed batch can also create a new block.
  const entries = [...compressibleEntries(), userMsg("e8", FILLER), userMsg("e9", FILLER)];
  entries[2] = userMsg("e3", LONG); // New range must also exceed minCompressRange.
  const { api, ctx, compress, stateFile } = await setup(`rebuild-refold-${mixed}`, registry, {
    acpJson: { compressionModelId: "cheap/summarizer" }, entries,
  });
  const record = async (name: string, id: string, args: any, tool: any) => {
    const result = await tool.execute(id, args, undefined, undefined, ctx);
    assert.doesNotMatch(result.content[0].text, /FAILED|Errors:/);
    const loggedName = facade && name === "decompress" ? "acp_context" : name;
    const loggedArgs = loggedName === "acp_context" ? { op: name, args } : args;
    entries.push({ type: "message", id: `${id}-call`, message: { role: "assistant", content: [{ type: "toolCall", name: loggedName, id, arguments: loggedArgs }], timestamp: 0 } });
    entries.push({ type: "message", id: `${id}-result`, message: { role: "toolResult", toolName: loggedName, toolCallId: id, ...result, isError: false, timestamp: 0 } });
    return result;
  };
  const initial = [{ startId: "m00001", endId: "m00001", summary: FALLBACK }];
  if (shape !== "single") initial.push({ startId: "m00002", endId: "m00002", summary: FALLBACK });
  await record("compress", "first", { content: initial }, compress);
  const decompress = api.tools.find((t: any) => t.name === "decompress")!;
  for (const blockId of shape === "adjacent" ? ["b1", "b2"] : ["b1"]) {
    const restored = await record("decompress", `restore-${blockId}`, { blockId, inline: true }, decompress);
    assert.match(restored.content[0].text, new RegExp(`^Restored block ${blockId} \\(`));
  }
  const restoredState = JSON.parse(await fs.readFile(`${stateFile}.acp.json`, "utf8"));
  assert.ok(restoredState.blocks.filter((b: any) => b.active).every((b: any) => b.restoredInline), "every active block was restored inline");
  const ranges = [{ startId: "m00001", endId: shape === "single" ? "m00001" : "m00002", summary: FALLBACK }];
  if (mixed) ranges.push({ startId: "m00003", endId: "m00003", summary: FALLBACK });
  const refold = await record("compress", "refold", { content: ranges }, compress);
  const live = JSON.parse(await fs.readFile(`${stateFile}.acp.json`, "utf8"));
  if (shape === "single" || mixed) {
    const expectedRecords = (shape === "adjacent" ? 2 : 1) + Number(mixed);
    assert.equal(refold.details?.acpFolded?.ranges.length, expectedRecords, "record every actually changed block, including cross-block refolds");
  } else {
    // Baseline 4b9bc2c: a fully consumed cross-block range bypasses the
    // dedicated model and uses the caller summary. Preserve that live behavior.
    assert.equal(refold.details?.acpFolded, undefined);
  }
  if (shape === "adjacent") assert.deepEqual(live.blocks.slice(0, 2).map((b: any) => b.summary), [FALLBACK, FALLBACK]);
  const recovered = await setup(`rebuild-refold-import-${mixed}`, registry, {
    acpJson: { compressionModelId: "cheap/summarizer" }, entries,
  });
  const rebuilt = JSON.parse(await fs.readFile(`${recovered.stateFile}.acp.json`, "utf8"));
  const memory = (s: any) => s.blocks.map(({ blockId, summary, effectiveMessageIds, active, restoredInline }: any) => ({ blockId, summary, effectiveMessageIds, active, restoredInline: restoredInline === true }));
  assert.deepEqual(memory(rebuilt), memory(live), "log-only recovery must retain the exact dedicated refold summary and block identity");
});

test("compress: an earlier block in the middle of the range is sent as a pinned summary", async () => {
  const calls: Call[] = [];
  const registry = fakeRegistry([model("cheap", "summarizer")], textReply(DEDICATED), calls);
  const { ctx, compress } = await setup("refold-mid", registry, {
    acpJson: { compressionModelId: "cheap/summarizer" },
    entries: [userMsg("e1", LONG), ...Array.from({ length: 10 }, (_, i) => userMsg(`e${i + 2}`, FILLER))],
  });
  const first = (await compress.execute("tc1", { content: [{ startId: "m00002", endId: "m00003", summary: FALLBACK }] }, undefined, undefined, ctx)).content?.[0]?.text;
  assert.match(String(first), /blocks: b1=/, String(first));
  const text = (await compress.execute("tc2", { content: [{ startId: "m00001", endId: "m00004", summary: FALLBACK }] }, undefined, undefined, ctx)).content?.[0]?.text;
  assert.match(String(text), /summaries written by cheap\/summarizer \(1\/1\)/);
  assert.equal(calls.length, 2);
  const prompt = String(calls[1]!.context.messages[0]!.content);
  assert.ok(prompt.includes("[earlier summary b1"), prompt.replace(/(lorem ipsum dolor sit amet )+/g, "<LOREM>").replace(/(filler text for padding purposes )+/g, "<FILLER>"));
  assert.ok(!prompt.includes("[Compressed conversation section]"), "the kernel's summary message is not sent as raw text");
  assert.equal(prompt.split("DEDICATED-SUMMARY").length - 1, 1, "the block summary is sent once");
});

test("compress: a range naming only a tool result sends its paired call too (what the kernel folds) plus the caller note", async () => {
  const calls: Call[] = [];
  const registry = fakeRegistry([model("cheap", "summarizer")], textReply(DEDICATED), calls);
  const call = { type: "message", id: "e2", parentId: null, timestamp: "", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", id: "callX", arguments: { command: "python read_other_session.py --session PMIC" } }], timestamp: Date.now() } };
  const result = { type: "message", id: "e3", parentId: null, timestamp: "", message: { role: "toolResult", toolCallId: "callX", toolName: "bash", content: [{ type: "text", text: `USER: consider only 1.8 V output\n${LONG}` }], timestamp: Date.now() } };
  const { ctx, compress, stateFile } = await setup("pair", registry, {
    acpJson: { compressionModelId: "cheap/summarizer" },
    entries: [userMsg("e1", FILLER), call, result, ...Array.from({ length: 6 }, (_, i) => userMsg(`e${i + 4}`, FILLER))],
  });
  const note = "Read another session's history to audit its compressions.";
  const text = (await compress.execute("tc1", { content: [{ startId: "m00003", endId: "m00003", summary: note }] }, undefined, undefined, ctx)).content?.[0]?.text;
  assert.match(String(text), /summaries written by cheap\/summarizer \(1\/1\)/, String(text));
  const state = JSON.parse(await fs.readFile(`${stateFile}.acp.json`, "utf8"));
  const folded: string[] = state.blocks[0].directMessageIds;
  assert.ok(folded.some((id) => id.startsWith("e2")), `kernel folds the call: ${folded}`);
  const prompt = String(calls[0]!.context.messages[0]!.content);
  assert.ok(prompt.includes("read_other_session.py"), "the summary model sees the call the kernel folds");
  assert.ok(prompt.includes("USER: consider only 1.8 V output"), "and its result");
  assert.ok(!prompt.includes("filler text"), "nothing outside the fold");
  assert.ok(prompt.includes(`<caller_note>\n${note}\n</caller_note>`), "caller fallback is passed as a note");
  assert.match(calls[0]!.context.systemPrompt, /SOURCE ATTRIBUTION/);
  assert.match(calls[0]!.context.systemPrompt, /CALLER NOTE/);
});

test("compress: fold planning does not depend on the caller fallback's length", async () => {
  const calls: Call[] = [];
  const registry = fakeRegistry([model("cheap", "summarizer")], textReply(DEDICATED), calls);
  const call = { type: "message", id: "e2", parentId: null, timestamp: "", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", id: "callY", arguments: { command: "python count_hits.py" } }], timestamp: Date.now() } };
  const result = { type: "message", id: "e3", parentId: null, timestamp: "", message: { role: "toolResult", toolCallId: "callY", toolName: "bash", content: [{ type: "text", text: `hits=31\n${LONG}` }], timestamp: Date.now() } };
  const { ctx, compress, stateFile } = await setup("pair-short", registry, {
    acpJson: { compressionModelId: "cheap/summarizer" },
    entries: [userMsg("e1", FILLER), call, result, ...Array.from({ length: 6 }, (_, i) => userMsg(`e${i + 4}`, FILLER))],
  });
  // Shorter than the kernel's minSummaryLength (50): a dry run with this
  // fallback would be rejected, while the real apply uses the model's summary.
  const text = (await compress.execute("tc1", { content: [{ startId: "m00003", endId: "m00003", summary: "hit counts" }] }, undefined, undefined, ctx)).content?.[0]?.text;
  assert.match(String(text), /summaries written by cheap\/summarizer \(1\/1\)/, String(text));
  const state = JSON.parse(await fs.readFile(`${stateFile}.acp.json`, "utf8"));
  assert.ok(state.blocks[0].directMessageIds.some((id: string) => id.startsWith("e2")), "kernel folds the call");
  assert.ok(String(calls[0]!.context.messages[0]!.content).includes("count_hits.py"), "the summary model sees the call");
});

test("fitToModel: fits the summary model window, falls back to 120K chars when unknown", () => {
  const text = "x".repeat(400_000); // ~100K tokens
  assert.equal(fitToModel([{ text }], { contextWindow: 400_000 }, 8000), text);
  const small = fitToModel([{ text }], { contextWindow: 50_000 }, 8000);
  assert.ok(small.length < 150_000 && small.includes("[... truncated ...]"), String(small.length));
  assert.equal(fitToModel([{ text }], {}, 8000).length, 120_000);
});

test("fitToModel: earlier block summaries survive truncation even mid-range", () => {
  const raw = "y".repeat(200_000);
  const parts = [{ text: raw }, { text: "[earlier summary b3]\nKEEP-SiUD412ED-0.5V", pinned: true }, { text: raw }];
  const out = fitToModel(parts, {}, 8000);
  assert.ok(out.length <= 120_000, String(out.length));
  assert.ok(out.startsWith("[earlier summary b3]\nKEEP-SiUD412ED-0.5V"), "pinned summary is kept whole and first");
  assert.ok(out.includes("[... truncated ...]"));
  // Pinned summaries that leave no room for raw text stay whole; raw is dropped.
  const big = "[earlier summary b4]\n" + "S".repeat(119_500);
  const tight = fitToModel([{ text: big, pinned: true }, { text: raw }], {}, 8000);
  assert.ok(tight.startsWith(big) && tight.length <= 120_000, String(tight.length));
  // Summaries that cannot fit whole are never cut: the dedicated call is
  // refused so the caller's own summary is kept.
  assert.throws(() => fitToModel([{ text: "Z".repeat(130_000), pinned: true }, { text: raw }], {}, 8000), /earlier block summaries/);
  assert.throws(() => fitToModel([{ text: "Z".repeat(130_000), pinned: true }], {}, 8000), /earlier block summaries/);
});

test("Lean: the compress result records the dedicated summary in details (for state rebuild)", async () => {
  const registry = fakeRegistry([model("cheap", "summarizer")], textReply(DEDICATED), []);
  const { compress, ctx } = await setup("details", registry, { acpJson: { compressionModelId: "cheap/summarizer" } });
  const out = await compress.execute("tc1", { content: [{ startId: "m00001", endId: "m00001", summary: FALLBACK }] }, undefined, undefined, ctx);
  assert.deepEqual(out.details?.acpFolded?.version, 1);
  const ranges = out.details.acpFolded.ranges;
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].startId, "m00001");
  assert.ok(ranges[0].summary.includes(DEDICATED), ranges[0].summary);
  // Without a dedicated model the arguments already hold the summary: no details.
  const plain = await setup("details-none", fakeRegistry([], textReply(DEDICATED), []));
  const out2 = await plain.compress.execute("tc1", { content: [{ startId: "m00001", endId: "m00001", summary: FALLBACK }] }, undefined, undefined, plain.ctx);
  assert.equal(out2.details, undefined);
});

test("Lean: details record only the ranges the kernel actually folded", async () => {
  const registry = fakeRegistry([model("cheap", "summarizer")], textReply(DEDICATED), []);
  const { compress, ctx } = await setup("details-partial", registry, { acpJson: { compressionModelId: "cheap/summarizer" } });
  const out = await compress.execute("tc1", { content: [
    { startId: "m00001", endId: "m00001", summary: FALLBACK },
    { startId: "m09998", endId: "m09999", summary: FALLBACK },
  ] }, undefined, undefined, ctx);
  const text = out.content.map((c: { text?: string }) => c.text ?? "").join("\n");
  assert.match(text, /m09998|m09999/, "the kernel reported the bad range");
  assert.deepEqual(out.details?.acpFolded?.ranges.map((r: { startId: string }) => r.startId), ["m00001"]);
});

test("Lean: duplicate overlapping ranges record only the summary actually applied", async () => {
  let n = 0;
  const registry = fakeRegistry([model("cheap", "summarizer")], async () => ({ role: "assistant", content: [{ type: "text", text: `${DEDICATED} revision ${++n}` }], stopReason: "stop" }), []);
  const { compress, ctx } = await setup("details-overlap", registry, { acpJson: { compressionModelId: "cheap/summarizer" } });
  const range = { startId: "m00001", endId: "m00001", summary: FALLBACK };
  const out = await compress.execute("overlap", { content: [range, range] }, undefined, undefined, ctx);
  assert.match(out.content[0].text, /overlaps an earlier range/);
  assert.equal(out.details?.acpFolded?.ranges.length, 1);
  assert.equal(out.details.acpFolded.ranges[0].summary, `${DEDICATED} revision 1`);
});

test("Lean: a failed dedicated call does not fold the range (no short-fallback block)", async () => {
  const calls: Call[] = [];
  const registry = fakeRegistry([model("cheap", "summarizer")], async () => { throw new Error("Connection error."); }, calls);
  const { run, stateFile } = await setup("fallback", registry, { acpJson: { compressionModelId: "cheap/summarizer" } });
  await assert.rejects(run(FALLBACK), /Summary model cheap\/summarizer failed for every range \(m00001\.\.m00001: Connection error\.\)\. Nothing was compressed/);
  assert.equal(calls.length, 1);
  assert.deepEqual(await readBlockSummaries(stateFile), [], "no block was created");
});

test("Lean: partial failure folds only the ranges whose summary succeeded", async () => {
  const calls: Call[] = [];
  let n = 0;
  const registry = fakeRegistry([model("cheap", "summarizer")], async () => {
    n += 1;
    if (n === 1) throw new Error("Connection error.");
    return { role: "assistant", content: [{ type: "text", text: DEDICATED }], stopReason: "stop" };
  }, calls);
  const { compress, ctx, stateFile } = await setup("partial", registry, { acpJson: { compressionModelId: "cheap/summarizer" } });
  const out = await compress.execute("tc1", { content: [
    { startId: "m00001", endId: "m00001", summary: FALLBACK },
    { startId: "m00002", endId: "m00003", summary: FALLBACK },
  ] }, undefined, undefined, ctx);
  const text = out.content?.[0]?.text ?? String(out);
  assert.equal(calls.length, 2);
  assert.match(text, /summaries written by cheap\/summarizer \(1\/2\)/, text);
  assert.match(text, /⚠️ .*NOT compressed — summary model cheap\/summarizer failed for m00001\.\.m00001 \(Connection error\.\); retry that range later/, text);
  const summaries = await readBlockSummaries(stateFile);
  assert.equal(summaries.length, 1, JSON.stringify(summaries));
  assert.ok(summaries[0]!.includes(DEDICATED));
  assert.ok(!summaries.some((s) => s.includes(FALLBACK)), "the failed range's fallback is not folded");
});

test("Lean: error and length stops do not fold; a host without complete() still falls back", async () => {
  const errReg = fakeRegistry([model("cheap", "summarizer")], async () => ({ role: "assistant", content: [], stopReason: "error", errorMessage: "429" }), []);
  const a = await setup("stop-error", errReg, { acpJson: { compressionModelId: "cheap/summarizer" } });
  await assert.rejects(a.run(FALLBACK), /failed for every range \(m00001\.\.m00001: 429\)/);
  assert.deepEqual(await readBlockSummaries(a.stateFile), []);

  // Output cut at the token limit: neither the half-written summary nor the short fallback is folded.
  const lenReg = fakeRegistry([model("cheap", "summarizer")], async () => ({ role: "assistant", content: [{ type: "text", text: "DEDICATED-SUMMARY: cut mid-sen" }], stopReason: "length" }), []);
  const l = await setup("stop-length", lenReg, { acpJson: { compressionModelId: "cheap/summarizer" } });
  await assert.rejects(l.run(FALLBACK), /hit its output limit/);
  assert.deepEqual(await readBlockSummaries(l.stateFile), []);

  const oldHost = { getAll: () => [model("cheap", "summarizer")], find: () => model("cheap", "summarizer") };
  const b = await setup("no-complete", oldHost, { acpJson: { compressionModelId: "cheap/summarizer" } });
  await b.run(FALLBACK);
  assert.ok((await readBlockSummaries(b.stateFile)).includes(FALLBACK));
});

test("compress: unresolvable model ref keeps the caller summary and warns", async () => {
  const registry = fakeRegistry([model("cheap", "summarizer")], textReply(DEDICATED), []);
  const { run, stateFile } = await setup("unresolved", registry, { acpJson: { compressionModelId: "ghost/model" } });
  const text = await run(FALLBACK);
  assert.match(text, /summary model ghost\/model is not resolvable/);
  assert.ok((await readBlockSummaries(stateFile)).includes(FALLBACK));
});

test("compress: session mode reuses the captured prefix, system prompt and active tools", async () => {
  const calls: Call[] = [];
  const session = model("mainprov", "main-model");
  const registry = fakeRegistry([session], textReply(DEDICATED), calls);
  const { run, stateFile } = await setup("session", registry, { acpJson: { compressionModelId: "session" }, sessionModel: session });
  const text = await run(FALLBACK);
  assert.match(text, /summaries written by session model mainprov\/main-model \(1\/1, shared prefix\)/);
  const { context } = calls[0]!;
  assert.equal(context.systemPrompt, "SESSION SYSTEM PROMPT");
  assert.deepEqual(context.tools.map((t: any) => t.name), ["read", "compress"]);
  const msgs = JSON.stringify(context.messages);
  assert.ok(msgs.includes("lorem ipsum") && msgs.includes("filler text"), "whole captured prefix is sent");
  assert.match(String(context.messages.at(-1).content), /Write the single detailed summary replacing m00001 through m00001/);
  assert.ok((await readBlockSummaries(stateFile)).includes(DEDICATED));
});

test("compress: session mode without a captured prefix takes the extracted-content path (planned fold + caller note)", async () => {
  const calls: Call[] = [];
  const session = model("mainprov", "main-model");
  const registry = fakeRegistry([session], textReply(DEDICATED), calls);
  const { handlers, ctx, run, stateFile } = await setup("session-noprefix", registry, { acpJson: { compressionModelId: "session" }, sessionModel: session });
  // session_shutdown drops the captured provider-bound prefix.
  const shutdown = handlers.get("session_shutdown") ?? [];
  assert.ok(shutdown.length > 0, "session_shutdown handler registered");
  for (const h of shutdown) await h({ type: "session_shutdown" }, ctx);
  const text = await run(FALLBACK);
  assert.match(text, /summaries written by session model mainprov\/main-model \(1\/1, extracted content\)/, text);
  const { context } = calls[0]!;
  assert.match(context.systemPrompt, /SOURCE ATTRIBUTION/);
  assert.ok(String(context.messages[0]!.content).includes("<caller_note>"), "caller fallback is passed as a note");
  assert.ok((await readBlockSummaries(stateFile)).includes(DEDICATED));
});

test("no compressionModelId: main-model summary, no side call, original description", async () => {
  const calls: Call[] = [];
  const registry = fakeRegistry([model("cheap", "summarizer")], textReply(DEDICATED), calls);
  const { run, stateFile, compress } = await setup("unset", registry);
  assert.match(compress.description, /detailed summaries you write/);
  const text = await run(FALLBACK);
  assert.doesNotMatch(text, /summar(y|ies) (model|written)/);
  assert.equal(calls.length, 0);
  assert.ok((await readBlockSummaries(stateFile)).includes(FALLBACK));
});

test("/acp compact: status, set provider/id, session, reset, ambiguous, unknown", async () => {
  const registry = fakeRegistry([model("cheap", "summarizer"), model("a", "dup"), model("b", "dup")], textReply(DEDICATED), []);
  let out = "";
  const { api, ctx, compress } = await setup("cmd", registry, { notify: (s) => (out = s), acpJson: { compress: { promptPack: "lean" } } });
  const acp = api.commands.get("acp");

  await acp.handler("compact", ctx);
  assert.match(out, /not set/);

  await acp.handler("compact summarizer", ctx);
  assert.match(out, /set to cheap\/summarizer/);
  let written = JSON.parse(await fs.readFile(acpJsonPath, "utf8"));
  assert.equal(written.compressionModelId, "cheap/summarizer");
  assert.deepEqual(written.compress, { promptPack: "lean" }, "unrelated keys preserved");
  assert.match(compress.description, /Dedicated summary model cheap\/summarizer/);

  await acp.handler("compact dup", ctx);
  assert.match(out, /Ambiguous model id "dup"[\s\S]*a\/dup[\s\S]*b\/dup/);

  await acp.handler("compact nope", ctx);
  assert.match(out, /not found[\s\S]*cheap\/summarizer/);

  await acp.handler("compact session", ctx);
  assert.match(out, /set to session/);
  await acp.handler("compact", ctx);
  assert.match(out, /Summary model: session/);

  await acp.handler("compact reset", ctx);
  assert.match(out, /cleared/);
  written = JSON.parse(await fs.readFile(acpJsonPath, "utf8"));
  assert.equal(written.compressionModelId, undefined);
  assert.doesNotMatch(compress.description, /Dedicated summary model/);
});

test("/acp compact refuses to overwrite an unparseable global acp.json", async () => {
  const registry = fakeRegistry([model("cheap", "summarizer")], textReply(DEDICATED), []);
  const { api, ctx } = await setup("badjson", registry);
  await fs.mkdir(path.dirname(acpJsonPath), { recursive: true });
  await fs.writeFile(acpJsonPath, "{ not json");
  await assert.rejects(() => api.commands.get("acp").handler("compact cheap/summarizer", ctx));
  assert.equal(await fs.readFile(acpJsonPath, "utf8"), "{ not json");
});

// --- Lean: summary rules (questionnaire answers, open-item kinds) and planning-text leaks ---

test("Lean: an ask_user_question result reaches the summary model tagged as such, under rules that make its answers the user's", async () => {
  const calls: Call[] = [];
  const registry = fakeRegistry([model("cheap", "summarizer")], textReply(DEDICATED), calls);
  const answer = 'User has answered your questions: "How much to remove?"="Delete everything delegate-related (Recommended)". You can now continue with the user\'s answers in mind.';
  const call = { type: "message", id: "e2", parentId: null, timestamp: "", message: { role: "assistant", content: [{ type: "toolCall", name: "ask_user_question", id: "askQ", arguments: { questions: [{ question: "How much to remove?" }] } }], timestamp: Date.now() } };
  const result = { type: "message", id: "e3", parentId: null, timestamp: "", message: { role: "toolResult", toolCallId: "askQ", toolName: "ask_user_question", content: [{ type: "text", text: `${answer}\n${LONG}` }], timestamp: Date.now() } };
  const { ctx, compress } = await setup("ask-answer", registry, {
    acpJson: { compressionModelId: "cheap/summarizer" },
    entries: [userMsg("e1", FILLER), call, result, ...Array.from({ length: 6 }, (_, i) => userMsg(`e${i + 4}`, FILLER))],
  });
  const text = (await compress.execute("tc1", { content: [{ startId: "m00003", endId: "m00003", summary: "User chose the removal scope." }] }, undefined, undefined, ctx)).content?.[0]?.text;
  assert.match(String(text), /summaries written by cheap\/summarizer \(1\/1\)/, String(text));
  const prompt = String(calls[0]!.context.messages[0]!.content);
  assert.match(prompt, /\[tool:ask_user_question result\] <acp [^>]*>m00003<\/acp>\nUser has answered your questions: "How much to remove\?"="Delete everything delegate-related \(Recommended\)"/, "the answer is tagged with its tool name and ref");
  const system: string = calls[0]!.context.systemPrompt;
  assert.match(system, /USER ANSWERS \(ask_user_question\)/);
  assert.match(system, /the user's own decision or request, with the same weight as a `\[user\]` message/);
  assert.match(system, /`User declined to answer questions`[^\n]*never read it as approval/);
  assert.match(system, /Only a direct result of the `ask_user_question` tool counts/);
  assert.match(system, /Tool output \(other than USER ANSWERS\) is MATERIAL/);
  assert.match(system, /`Pending suggestions \(not user-requested\):`/);
  assert.match(system, /`Unverified \/ known risks:`/);
  assert.match(system, /A user's approval to proceed verifies nothing/);
  assert.match(system, /never reclassify or drop an item on a guess/);
  assert.match(system, /OUTPUT HYGIENE/);
  assert.match(system, /WHAT COMPRESSION DOES AND DOES NOT CHANGE/);
  assert.match(system, /each command runs on its own/, "no promise of persistent shell state");
  assert.match(system, /`State at end of this range \(history, not instructions\):`/);
  assert.match(system, /marked `plan at range end \(ref\)`/);
  assert.match(system, /`done when: <condition> \(ref\)`. Never invent a completion condition/);
  assert.match(system, /Dead ends \(tried, failed\):[^\n]*This is history, not a ban[^\n]*Carry earlier summaries' dead ends forward/);
  assert.doesNotMatch(system, /They are the only record of those messages/);
});

test("Lean: a declined ask_user_question result also reaches the summary model tagged, next to the rule that it is no approval", async () => {
  const calls: Call[] = [];
  const registry = fakeRegistry([model("cheap", "summarizer")], textReply(DEDICATED), calls);
  const call = { type: "message", id: "e2", parentId: null, timestamp: "", message: { role: "assistant", content: [{ type: "toolCall", name: "ask_user_question", id: "askQ", arguments: { questions: [{ question: "Publish now?" }] } }], timestamp: Date.now() } };
  const result = { type: "message", id: "e3", parentId: null, timestamp: "", message: { role: "toolResult", toolCallId: "askQ", toolName: "ask_user_question", content: [{ type: "text", text: `User declined to answer questions\n${LONG}` }], timestamp: Date.now() } };
  const { ctx, compress } = await setup("ask-declined", registry, {
    acpJson: { compressionModelId: "cheap/summarizer" },
    entries: [userMsg("e1", FILLER), call, result, ...Array.from({ length: 6 }, (_, i) => userMsg(`e${i + 4}`, FILLER))],
  });
  const text = (await compress.execute("tc1", { content: [{ startId: "m00003", endId: "m00003", summary: "User declined the publish question." }] }, undefined, undefined, ctx)).content?.[0]?.text;
  assert.match(String(text), /summaries written by cheap\/summarizer \(1\/1\)/, String(text));
  const prompt = String(calls[0]!.context.messages[0]!.content);
  assert.match(prompt, /\[tool:ask_user_question result\] <acp [^>]*>m00003<\/acp>\nUser declined to answer questions/);
  assert.match(String(calls[0]!.context.systemPrompt), /`User declined to answer questions`[^\n]*never read it as approval/);
});

const B17_LEAK = "We need produce summary m00195-m00770 incorporating preceding compressed summaries and all current updates. Mention active_doubler desktop copied and backup. Good.\n\nOutput only summary. Could compress historical R5 details.## Overall goal and evolution\n\n- User accepted SiUD412ED for Q4/Q5 (m00559).";
const CLEAN = "## Overall goal\n\n- DEDICATED-SUMMARY: the user accepted the part (m00559); its IGSS unit is still unverified (m00551).";

test("Lean: detectPlanningLeak catches planning openings, not quoted or late mentions", () => {
  assert.ok(detectPlanningLeak(B17_LEAK));
  assert.ok(detectPlanningLeak("I'll write the summary now. ## Goal\n- x"));
  assert.ok(detectPlanningLeak("Notes first. Output only the summary, keep refs.\n## Goal"));
  // Seen in the Luna A/B (2026-10-12): planning without the word "write" / "output only".
  assert.ok(detectPlanningLeak("We need deliver summary only based caller note and transcript. Must accurately status work begun.\n\n- User asked (m00001) …"));
  assert.ok(detectPlanningLeak("For this block there is only caller_note metadata. Continue prior work from the earlier summary. Need keep task history/open objective from note. Must honor detailed summary.\n\n- 用户此前要求（m00001）"));
  assert.ok(detectPlanningLeak("I’m at the end of this range. The checks are complete, so I’ll preserve the objective.\n\n## Goal"));
  assert.equal(detectPlanningLeak(CLEAN), null);
  assert.equal(detectPlanningLeak('## Leak audit\n- b17 began with "Output only summary. Could compress" (planning text).'), null, "quoted");
  assert.equal(detectPlanningLeak("## Goal\n- The main model needs to write a fallback summary; we will produce summaries with Luna."), null, "not at the start");
  assert.equal(detectPlanningLeak(`## Goal\n${"- fact\n".repeat(400)}Output only summary`), null, "beyond the opening");
  // Prose openings that state facts, even about summaries, are not planning.
  assert.equal(detectPlanningLeak("TASK AS OF THIS BLOCK: the summary model now gets the caller note; we verified it in m00012.\n\n- details"), null);
  assert.equal(detectPlanningLeak("User directed priority: A -> B. Emphasized baseline MUST come from the original client.\n- x"), null);
  assert.equal(detectPlanningLeak("## Requirements\n- User requested output only summary (m00001)."), null, "the phrase as a fact inside the summary body");
});

test("Lean: a planning-text leak is retried once with a reminder; the clean retry is folded", async () => {
  const calls: Call[] = [];
  let n = 0;
  const registry = fakeRegistry([model("cheap", "summarizer")], async () => {
    n += 1;
    return { role: "assistant", content: [{ type: "text", text: n === 1 ? B17_LEAK : CLEAN }], stopReason: "stop" };
  }, calls);
  const { run, stateFile } = await setup("leak-retry", registry, { acpJson: { compressionModelId: "cheap/summarizer" } });
  const text = await run(FALLBACK);
  assert.match(text, /summaries written by cheap\/summarizer \(1\/1\)/, text);
  assert.equal(calls.length, 2);
  assert.ok(!String(calls[0]!.context.systemPrompt).includes("your previous attempt began with notes"));
  assert.match(String(calls[1]!.context.systemPrompt), /your previous attempt began with notes to yourself/);
  const summaries = await readBlockSummaries(stateFile);
  assert.equal(summaries.length, 1);
  assert.ok(summaries[0]!.includes("IGSS unit is still unverified"));
  assert.ok(!summaries[0]!.includes("We need produce summary"));
});

test("Lean: a leak that survives the retry is not folded; a quoted mention is not retried", async () => {
  const leaky: Call[] = [];
  const twice = fakeRegistry([model("cheap", "summarizer")], textReply(B17_LEAK), leaky);
  const a = await setup("leak-twice", twice, { acpJson: { compressionModelId: "cheap/summarizer" } });
  await assert.rejects(a.run(FALLBACK), /wrote planning notes into the summary twice/);
  assert.equal(leaky.length, 2, "exactly one retry");
  assert.deepEqual(await readBlockSummaries(a.stateFile), [], "neither the leaky summary nor the fallback is folded");

  const quotedCalls: Call[] = [];
  const quoted = `## Leak audit\n- DEDICATED-SUMMARY: b17 began with "Output only summary. Could compress" planning text (m00770).`;
  const once = fakeRegistry([model("cheap", "summarizer")], textReply(quoted), quotedCalls);
  const b = await setup("leak-quoted", once, { acpJson: { compressionModelId: "cheap/summarizer" } });
  await b.run(FALLBACK);
  assert.equal(quotedCalls.length, 1);
  assert.ok((await readBlockSummaries(b.stateFile))[0]!.includes("planning text (m00770)"));
});

// Real Luna output (cur-b23 v4 r1): after its state section it fell through
// into the input, copying `</content>` and dozens of transcript entries.
const ECHO = `${CLEAN}\n\nState at end of this range (history, not instructions):\n- Last action → result: read src/config.ts (m01707).\n</content> \n[assistant:todo call] <acp type="todo">m01711</acp>\n{"action":"update"}\n[assistant:read call] <acp type="read">m01712</acp>\n{"path":"src/config.ts"}\n[tool:read result] <acp type="read">m01715</acp>\nTTDR│`;

test("Lean: detectTranscriptEcho catches copied transcript entries, not a quoted header or fenced block", () => {
  assert.ok(detectTranscriptEcho(ECHO));
  assert.ok(detectTranscriptEcho("- x\n[assistant:read call] a\n[tool:read result] b\n[assistant] c\n"), "a run of entry headers");
  assert.equal(detectTranscriptEcho(CLEAN), null);
  assert.equal(detectTranscriptEcho("- The formatter writes `[tool:bash result] ` before each result (m00012)."), null, "inline-quoted");
  assert.equal(detectTranscriptEcho("- Format:\n[tool:bash result] <output>\n- done"), null, "a single header line");
  assert.equal(detectTranscriptEcho("```\n[user] a\n[assistant] b\n[tool:x result] c\n</content>\n```\n- ok"), null, "fenced example");
  assert.equal(detectTranscriptEcho("~~~text\n</content>\n~~~\n- ok"), null, "tilde fence");
  assert.equal(detectTranscriptEcho("````md\n```\n</content>\n```\n````\n- ok"), null, "four-backtick fence containing a three-backtick one");
  assert.ok(detectTranscriptEcho("```\nx\n```\n- ok\n</content>\n"), "a tag after a closed fence still counts");
  assert.equal(detectTranscriptEcho("- Chapter layout:\n<content>\n- body goes here"), null, "an opening tag alone is not an echo");
  assert.equal(detectTranscriptEcho("- Output format: `<content>正文</content>` per chapter."), null, "inline tag");
});

test("Lean: a transcript echo is retried once with its own reminder; a second echo is not folded", async () => {
  const calls: Call[] = [];
  let n = 0;
  const registry = fakeRegistry([model("cheap", "summarizer")], async () => {
    n += 1;
    return { role: "assistant", content: [{ type: "text", text: n === 1 ? ECHO : CLEAN }], stopReason: "stop" };
  }, calls);
  const a = await setup("echo-retry", registry, { acpJson: { compressionModelId: "cheap/summarizer" } });
  await a.run(FALLBACK);
  assert.equal(calls.length, 2);
  assert.match(String(calls[1]!.context.systemPrompt), /your previous attempt copied transcript entries/);
  const kept = await readBlockSummaries(a.stateFile);
  assert.equal(kept.length, 1);
  assert.ok(!kept[0]!.includes("</content>"));

  const twice: Call[] = [];
  const b = await setup("echo-twice", fakeRegistry([model("cheap", "summarizer")], textReply(ECHO), twice), { acpJson: { compressionModelId: "cheap/summarizer" } });
  await assert.rejects(b.run(FALLBACK), /wrote transcript entries into the summary twice/);
  assert.equal(twice.length, 2);
  assert.deepEqual(await readBlockSummaries(b.stateFile), []);
});
