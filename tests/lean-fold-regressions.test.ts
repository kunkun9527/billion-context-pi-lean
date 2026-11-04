import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAcpExtension } from "../src/index.js";
import { createCore, createInitialState, defaultConfig } from "acp-kernel";
import { rebuildStateFromLog } from "../src/state-rebuild.js";
import type { AdapterConfig } from "../src/config.js";

const summary = "Detailed summary retaining the original findings, decisions and pending work, with sufficient length to pass the summary gate.";
const entry = (id: string, role: string, text: string): any => ({ type: "message", id, parentId: null, timestamp: "2026-11-04T00:00:00Z", message: { role, content: role === "user" ? text : [{ type: "text", text }], timestamp: 1, stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } } });
const textOf = (m: any): string => typeof m?.content === "string" ? m.content : (m?.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
function harness(entries: any[], file: string, adapter: AdapterConfig = {}) {
  const handlers = new Map<string, any[]>();
  const api = { tools: [] as any[], on(name: string, fn: any) { const a = handlers.get(name) ?? []; a.push(fn); handlers.set(name, a); }, registerTool(t: any) { this.tools.push(t); }, registerCommand() {} };
  createAcpExtension(adapter)(api as any);
  const ctx: any = { mode: "rpc", cwd: process.cwd(), hasUI: false, ui: { notify() {}, setStatus() {} }, model: { contextWindow: 100000, maxTokens: 1 }, sessionManager: { buildContextEntries: () => entries, getEntries: () => entries, getSessionId: () => file, getSessionFile: () => file } };
  return { ctx, tools: api.tools, context: async () => {
    let event: any = { type: "context", messages: entries.map(e => e.message) };
    for (const fn of handlers.get("context") ?? []) { const out = await fn(event, ctx); if (out) event = { ...event, ...out }; }
    return event.messages as any[];
  } };
}

function largeHistory(): any[] {
  return [entry("warm", "user", "start ".repeat(100)), entry("big", "assistant", "alpha-beta ".repeat(4000)), ...Array.from({ length: 10 }, (_, i) => entry(`tail${i}`, i % 2 ? "assistant" : "user", `small tail ${i}`))];
}
const largeText = (messages: any[]) => messages.map(textOf).find(text => text.includes("alpha-beta"))!;

test("truncation: real context stays stable across pressure drop, resume and inherited fork", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lean-truncate-"));
  try {
    const entries = largeHistory();
    const file = join(dir, "parent.jsonl");
    const h = harness(entries, file);
    let tokens = 96000;
    h.ctx.getContextUsage = () => ({ tokens });
    const first = largeText(await h.context());
    assert.match(first, /\[truncated for context space\]/);
    tokens = 60000;
    assert.ok(largeText(await h.context()) === first, "identical clipped body after pressure drop");
    const persisted = JSON.parse(await readFile(`${file}.acp.json`, "utf8"));
    assert.equal(persisted.blocks.length, 0, "latch-only state is sufficient for recovery");
    assert.equal(persisted.emergencyTruncateLatch[0].id, "big");
    const resumed = harness(entries, file);
    resumed.ctx.getContextUsage = () => ({ tokens });
    assert.ok(largeText(await resumed.context()) === first, "identical clipped body after process restart");
    const childFile = join(dir, "child.jsonl");
    await writeFile(childFile, JSON.stringify({ type: "session", parentSession: file }) + "\n", "utf8");
    const childEntries = entries.slice();
    const child = harness(childEntries, childFile);
    child.ctx.getContextUsage = () => ({ tokens });
    assert.ok(largeText(await child.context()) === first, "fork inherits only matching prefix clips");
    childEntries.splice(1, 1);
    await child.context();
    childEntries.splice(1, 0, entries[1]);
    assert.ok(largeText(await child.context()).length > 40000, "rewind retires a clip instead of leaking it to a later branch");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("truncation: a Pi context_edit keeps its corrected content, not the old cached clip", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lean-truncate-edit-"));
  try {
    const entries = largeHistory();
    const file = join(dir, "session.jsonl");
    const h = harness(entries, file);
    let tokens = 96000;
    h.ctx.getContextUsage = () => ({ tokens });
    assert.match(largeText(await h.context()), /\[truncated for context space\]/);
    entries.push({ type: "context_edit", id: "edit", targetId: "big", replacement: { content: "corrected content from Pi" }, parentId: null, timestamp: "" });
    tokens = 60000;
    const visible = (await h.context()).map(textOf).join("\n");
    assert.ok(visible.includes("corrected content from Pi"));
    assert.ok(!visible.includes("alpha-beta"));
    const persisted = JSON.parse(await readFile(`${file}.acp.json`, "utf8"));
    assert.ok(!persisted.emergencyTruncateLatch?.some((clip: any) => clip.id === "big"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("truncation: latest-user protection and its alternate clips survive the next turn and restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lean-truncate-user-"));
  try {
    const critical = "critical-user ".repeat(8000);
    const entries = [entry("old", "assistant", "alpha-beta ".repeat(4000)), entry("latest", "user", critical), ...Array.from({ length: 10 }, (_, i) => entry(`a${i}`, "assistant", `tail ${i}`))];
    const file = join(dir, "session.jsonl");
    const h = harness(entries, file);
    let tokens = 96000;
    h.ctx.getContextUsage = () => ({ tokens });
    const first = await h.context();
    assert.ok(first.map(textOf).some(text => text.includes(critical)), "latest user stays whole");
    const clipped = largeText(first);
    assert.match(clipped, /\[truncated for context space\]/);
    const persisted = JSON.parse(await readFile(`${file}.acp.json`, "utf8"));
    assert.ok(!persisted.emergencyTruncateLatch.some((clip: any) => clip.id === "latest"));
    assert.ok(persisted.emergencyTruncateLatch.some((clip: any) => clip.id === "old"));
    tokens = 60000;
    for (const current of [h, harness(entries, file)]) {
      current.ctx.getContextUsage = () => ({ tokens });
      const next = await current.context();
      assert.ok(largeText(next) === clipped, "the actual alternate clip is persisted, not the kernel's discarded user clip");
      assert.ok(next.map(textOf).some(text => text.includes(critical)));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const dedicated of [false, true]) test(`#3953: real compress/context ${dedicated ? "with dedicated summary dry-run" : "with caller summary"} keeps question before answers`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "lean-fold-"));
  try {
    const entries = Array.from({ length: 10 }, (_, i) => entry(`p${i + 1}`, i + 1 > 7 ? "assistant" : i % 2 ? "assistant" : "user", `body ${i + 1} `.repeat(120)));
    const file = join(dir, "session.jsonl");
    const h = harness(entries, file, { preserveRecentMessages: 1, coreOverrides: { preserveRecentTokens: 0 }, ...(dedicated ? { compressionModelId: "test/summary" } : {}) });
    const prompts: string[] = [];
    if (dedicated) {
      const model = { provider: "test", id: "summary", contextWindow: 200000, maxTokens: 8000 };
      h.ctx.modelRegistry = { getAll: () => [model], find: () => model, complete: async (_m: any, context: any) => { prompts.push(JSON.stringify(context.messages)); return { role: "assistant", content: [{ type: "text", text: summary }], stopReason: "stop" }; } };
    }
    await h.context();
    const out = await h.tools.find(t => t.name === "compress").execute("compress", { content: [{ startId: "m00002", endId: "m00009", summary }] }, undefined, undefined, h.ctx);
    assert.match(textOf(out), /blocks: b\d+=/);
    const state = JSON.parse(await readFile(`${file}.acp.json`, "utf8"));
    assert.deepEqual(state.blocks[0].effectiveMessageIds, ["p2", "p3", "p4", "p5", "p6"]);
    const log = [...entries,
      { type: "message", id: "fold-call", message: { role: "assistant", content: [{ type: "toolCall", name: "compress", id: "compress", arguments: { content: [{ startId: "m00002", endId: "m00009", summary }] } }] } },
      { type: "message", id: "fold-result", message: { role: "toolResult", toolName: "compress", toolCallId: "compress", content: out.content, details: out.details } },
    ];
    const rebuilt = rebuildStateFromLog({ entries: log, state: createInitialState(), core: createCore(), config: defaultConfig(100000, { preserveRecentMessages: 1, preserveRecentTokens: 0 }) });
    assert.equal(rebuilt.report.callsApplied, 1, rebuilt.report.errors.join("; "));
    assert.deepEqual(rebuilt.state.blocks[0]!.effectiveMessageIds, state.blocks[0].effectiveMessageIds, "log-only recovery preserves the exact live protected boundary");
    const visible = (await h.context()).map(textOf).join("\n");
    assert.ok(visible.indexOf("body 7 ") < visible.indexOf("body 8 "));
    for (const i of [7, 8, 9]) assert.ok(visible.includes(`body ${i} `), `body ${i} stays visible`);
    if (dedicated) {
      assert.equal(prompts.length, 1);
      assert.ok(prompts[0]!.includes("body 2 "));
      for (const i of [7, 8, 9]) assert.ok(!prompts[0]!.includes(`body ${i} `), "summary input equals actual folded prefix");
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
