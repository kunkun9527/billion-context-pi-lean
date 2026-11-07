import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, measureTurnInputs, displayTokenCount, sentViewTokenCount } from "../src/tokens.js";
import { createInitialState } from "acp-kernel";
import { createRuntime } from "../src/runtime.js";
import { entriesToCoreMessages } from "../src/messages.js";
import { makeCompressTool } from "../src/compress-tool.js";
import { makeStatusTool } from "../src/status-tool.js";

function measurementFixture() {
  const runtime = createRuntime({ modelContextLimit: 200_000, preserveRecentMessages: 1, compress: { reasoning: { drop: false } } });
  const entries: any[] = Array.from({ length: 8 }, (_, i) => ({ type: "message", id: `e${i}`, message: { role: "user", content: "中".repeat(6000), timestamp: 0 } }));
  entries.push({ type: "message", id: "thinking", message: { role: "assistant", content: [{ type: "thinking", thinking: "x".repeat(400) }, { type: "toolCall", id: "prior", name: "compress", arguments: {} }], timestamp: 0 } });
  const snapshot = { state: createInitialState(), entries, coreMessages: entriesToCoreMessages(entries) };
  const ctx: any = {
    cwd: process.cwd(), model: { id: "small", contextWindow: 200_000, maxTokens: 20_000, api: "openai-completions" },
    getSystemPrompt: () => "system", getContextUsage: () => null,
    sessionManager: { getSessionId: () => "measurement", getSessionFile: () => undefined },
    ui: { notify: () => {} },
  };
  runtime.overflowFor("measurement").setLearnedWindow("small", 130_000);
  runtime.overflowFor("measurement").armed = true;
  runtime.stateFor = async () => snapshot;
  return { runtime, snapshot, ctx };
}

test("shared ruler recenters per model before reserving headroom and counts retained compress thinking", () => {
  const { runtime, snapshot, ctx } = measurementFixture();
  const measurement = measureTurnInputs(runtime, ctx, snapshot);
  assert.equal(measurement.fullWindow, 130_000);
  assert.equal(measurement.config.modelContextLimit, 110_000);
  assert.equal(measurement.fixedTokens, measurement.systemPromptTokens + 100);
  assert.equal(runtime.configFor(ctx).modelContextLimit, 200_000, "shared config is not changed");
  assert.equal(runtime.overflowFor("measurement").armed, true);
  ctx.model.id = "bigger";
  assert.equal(measureTurnInputs(runtime, ctx, snapshot).config.modelContextLimit, 180_000, "learned window never leaks across models");
});

for (const purpose of ["status-tool", "status-command", "compress-preview"]) test(`${purpose} uses the effective ruler without consuming send-only state`, async () => {
  const { runtime, snapshot, ctx } = measurementFixture();
  const counts: number[] = [];
  const processTurn = runtime.core.processTurn.bind(runtime.core);
  runtime.core.processTurn = (input) => { counts.push(input.config.modelContextLimit); return processTurn(input); };
  runtime.noteHostUsage = () => { throw new Error("read-only paths must not sample calibration"); };
  runtime.noteSentViewCount = () => { throw new Error("read-only paths must not write the send meter"); };
  const before = structuredClone(snapshot.state);
  if (purpose === "compress-preview") {
    await makeCompressTool(runtime).execute("new-compress", { content: [{ startId: "m00001", endId: "m00001", summary: "A useful fallback summary long enough to pass kernel validation." }] }, undefined, undefined, ctx);
  } else if (purpose === "status-tool") {
    await makeStatusTool(runtime).execute("status", {}, undefined, undefined, ctx);
  } else {
    (globalThis as Record<string, unknown>).CURRENT_VERSION ??= "0.0.0-test";
    const { makeCommands } = await import("../src/commands.js");
    await makeCommands(runtime).find((c) => c.name === "acp")!.options.handler!("", ctx);
  }
  assert.ok(counts.length > 0);
  assert.ok(counts.every((limit) => limit === 110_000), JSON.stringify(counts));
  assert.equal(runtime.overflowFor("measurement").armed, true);
  if (purpose !== "compress-preview") assert.deepEqual(snapshot.state, before, "display must not mutate live counters");
});

test("sent-view probe clones state and disables cached clip replay", () => {
  const { runtime, snapshot, ctx } = measurementFixture();
  const measurement = measureTurnInputs(runtime, ctx, snapshot);
  snapshot.state.emergencyTruncateLatch = { test: "sentinel" } as any;
  const before = structuredClone(snapshot.state);
  const processTurn = runtime.core.processTurn.bind(runtime.core);
  runtime.core.processTurn = (input) => {
    assert.notEqual(input.state, snapshot.state);
    assert.equal(input.state.emergencyTruncateLatch, undefined);
    assert.ok(input.tokenCount < input.config.modelContextLimit * input.config.truncate.threshold);
    return processTurn(input);
  };
  sentViewTokenCount(runtime.core, snapshot.coreMessages, snapshot.state, measurement.config, 200_000, measurement.imageTokens, measurement.fixedTokens);
  assert.deepEqual(snapshot.state, before);
});

for (const anchor of ["fresh", "stale", "edited", "aborted", "missing"]) test(`shared measurement preserves provider-floor trust and display policy: ${anchor}`, () => {
  const { runtime, snapshot, ctx } = measurementFixture();
  ctx.getContextUsage = () => ({ tokens: 90_000, percent: 45 });
  const usage: any = { type: "message", id: "usage", message: { role: "assistant", content: [], usage: { input: 90_000 }, stopReason: anchor === "aborted" ? "aborted" : "stop" } };
  if (anchor !== "missing") snapshot.entries.push(usage);
  if (anchor === "edited") snapshot.entries.push({ type: "context_edit", id: "edit" });
  if (anchor === "stale") {
    snapshot.entries.push({ type: "message", id: "folded", message: { role: "toolResult", toolName: "compress", toolCallId: "fold", content: [{ type: "text", text: "▣ ACP | 40K → 10K tokens (~30K reclaimed, blocks: b1=m00001)" }] } });
    snapshot.state.blocks.push({ blockId: "b1", active: true, compressCallId: "fold", compressedTokens: 30_000, summary: "summary", effectiveMessageIds: [] } as any);
  }
  const measurement = measureTurnInputs(runtime, ctx, snapshot);
  const trusted = anchor === "fresh" || anchor === "stale";
  assert.equal(measurement.realPromptTokens, trusted ? 90_000 : 0);
  assert.equal(measurement.hostFloor, anchor === "stale" ? 60_002 : trusted ? 90_000 : 0);
  // Baseline: display skips a stale anchor, while send retains its net-reclaimed
  // floor. Sharing mechanisms must not silently merge these two policies.
  assert.equal(displayTokenCount(10_000, measurement), anchor === "fresh" ? 90_000 : 10_000);
  assert.equal(runtime.overflowFor("measurement").armed, true);
});

test("the shared ruler preserves Anthropic output-headroom exemption", () => {
  const { runtime, snapshot, ctx } = measurementFixture();
  ctx.model.api = "anthropic-messages";
  assert.equal(measureTurnInputs(runtime, ctx, snapshot).config.modelContextLimit, 130_000);
});

test("estimateTokens matches kernel defaultCountTokens (CJK 1:1 + chars/4)", () => {
  const msgs = [
    { id: "m1", role: "user", contentType: "text", text: "hello world foo bar baz" },
  ];
  // defaultCountTokens (acp-kernel 0.0.7+): CJK 1:1 + non-CJK chars/4.
  // 24 non-CJK chars → ceil(24/4) = 6
  assert.equal(estimateTokens(msgs), 6);
});

test("estimateTokens is consistent with kernel counter for CJK (each char = 1 token)", () => {
  const zh = "这是一个中文测试";
  const msgs = [{ id: "m1", role: "user", contentType: "text", text: zh }];
  // 8 CJK chars → 8 tokens under defaultCountTokens; chars/4 would give 2
  assert.equal(estimateTokens(msgs), 8);
});

test("estimateTokens skips compress tool calls", () => {
  const msgs = [
    { id: "m1", role: "user", contentType: "text", text: "alpha beta gamma" },
    { id: "m2", role: "assistant", contentType: "tool-call", toolName: "compress", text: "ignored payload here" },
    { id: "m3", role: "user", contentType: "text", text: "delta epsilon" },
  ];
  // m1 (4) + skip m2 (compress) + m3 (4) = 8
  assert.equal(estimateTokens(msgs), 8);
});

test("estimateTokens counts compress tool results (sent as plain text)", () => {
  const msgs = [
    { id: "m2", role: "assistant", contentType: "tool-call", toolName: "compress", text: "ignored payload here" },
    { id: "m3", role: "tool", contentType: "tool-result", toolName: "compress", text: "alpha beta gamma" },
  ];
  assert.equal(estimateTokens(msgs as any), 4);
});

test("estimateTokens skips covered (already-compressed) message ids", () => {
  const msgs = [
    { id: "m1", role: "user", contentType: "text", text: "alpha beta gamma" },
    { id: "m3", role: "user", contentType: "text", text: "delta epsilon" },
  ];
  const covered = new Set(["m3"]);
  // m1 (4) + skip m3 (covered) = 4
  assert.equal(estimateTokens(msgs, covered), 4);
});


