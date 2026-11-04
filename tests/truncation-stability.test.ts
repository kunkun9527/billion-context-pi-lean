import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStateStore } from "../src/state.js";
import { sentViewTokenCount } from "../src/tokens.js";
import { assignRefs, createCore, createInitialState, defaultConfig, type CoreMessage, type CompressionState } from "acp-kernel";

const BODY = "alpha-beta ".repeat(4000);
function setup() {
  const core = createCore();
  const messages: CoreMessage[] = [
    { id: "warm", role: "user", contentType: "text", text: "start ".repeat(1000) },
    { id: "big", role: "assistant", contentType: "text", text: BODY },
    ...Array.from({ length: 10 }, (_, i): CoreMessage => ({ id: `tail${i}`, role: i % 2 ? "assistant" : "user", contentType: "text", text: `tail ${i}` })),
  ];
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, { existing: state.messageRefs, nextIndex: 1 }).map;
  const config = defaultConfig(100000);
  const run = (state: CompressionState, tokenCount: number, input = messages) => core.processTurn({ messages: input, state, config, tokenCount });
  return { core, state, messages, config, run };
}
const body = (messages: CoreMessage[], id = "big") => messages.find(m => m.id === id)!.text!;

test("truncation: a pressure drop does not restore the same historical body", () => {
  const h = setup();
  const first = h.run(h.state, 96000);
  assert.match(body(first.messages), /\[truncated for context space\]/);
  const next = h.run(first.state, 60000);
  assert.equal(body(next.messages), body(first.messages));
});

test("truncation: same raw id/ref with edited text never replays an old body", () => {
  const h = setup();
  const first = h.run(h.state, 96000);
  const edited = h.messages.map(m => m.id === "big" ? { ...m, text: "the corrected body" } : m);
  const next = h.run(first.state, 60000, edited);
  assert.equal(next.state.messageRefs.byRaw.big, first.state.messageRefs.byRaw.big);
  assert.ok(body(next.messages).includes("the corrected body"));
  assert.ok(!body(next.messages).includes("alpha-beta"));
});

test("truncation: removing a message retires its clip, even if the id later returns", () => {
  const h = setup();
  const first = h.run(h.state, 96000);
  const branch = h.run(first.state, 60000, h.messages.filter(m => m.id !== "big"));
  const back = h.run(branch.state, 60000);
  assert.ok(body(back.messages).includes(BODY));
});

test("truncation: replayed savings are not charged again against new candidates", () => {
  const h = setup();
  const first = h.run(h.state, 96000);
  const extra: CoreMessage = { id: "extra", role: "assistant", contentType: "text", text: "new candidate ".repeat(1000) };
  const next = h.run(first.state, 96000, [...h.messages.slice(0, 2), extra, ...h.messages.slice(2)]);
  assert.ok(body(next.messages, "extra").includes(extra.text!));
  assert.equal(body(next.messages), body(first.messages));
});

test("truncation: distinct messages sharing BLOCKED refs cannot replay each other's clip", () => {
  const h = setup();
  const other: CoreMessage = { id: "other", role: "tool", contentType: "tool-result", toolName: "read", toolCallId: "other-call", text: "separate-result ".repeat(3000) };
  const messages = [h.messages[0]!, { ...h.messages[1]!, role: "tool" as const, contentType: "tool-result" as const, toolName: "read", toolCallId: "big-call" }, other, ...h.messages.slice(2)];
  const config = defaultConfig(100000, { protectedTools: ["read"] });
  const first = h.core.processTurn({ messages, state: createInitialState(), config, tokenCount: 200000 });
  assert.equal(first.state.messageRefs.byRaw.big, "BLOCKED");
  assert.equal(first.state.messageRefs.byRaw.other, "BLOCKED");
  const next = h.core.processTurn({ messages, state: first.state, config, tokenCount: 60000 });
  assert.equal(body(next.messages), body(first.messages));
  assert.equal(body(next.messages, "other"), body(first.messages, "other"));
  assert.ok(!body(next.messages, "other").includes("alpha-beta"));
});

test("truncation: a replayed clip below the emergency watermark does not produce terminal escape", () => {
  const h = setup();
  const messages = h.messages.map(m => m.id === "big" ? { ...m, role: "tool" as const, contentType: "tool-result" as const, toolName: "read", toolCallId: "big-call" } : m);
  const config = defaultConfig(100000, { protectedTools: ["read"] });
  let state = h.state;
  for (let i = 0; i < 5; i++) {
    const turn = h.core.processTurn({ messages, state, config, tokenCount: 96000 });
    assert.equal(turn.terminalEscape, undefined, "cached savings already bring the final request below the emergency watermark");
    state = turn.state;
  }
});

test("truncation: persisted clip count stays bounded", () => {
  const h = setup();
  const messages: CoreMessage[] = Array.from({ length: 140 }, (_, i) => ({ id: `large${i}`, role: "assistant", contentType: "text", text: `large body ${i} `.repeat(1000) }));
  const config = defaultConfig(100000, { preserveRecentMessages: 0, preserveRecentTokens: 0 });
  const first = h.core.processTurn({ messages, state: createInitialState(), config, tokenCount: 2000000 });
  assert.equal(first.state.emergencyTruncateLatch!.length, 128);
});

test("truncation: sidecar loading ignores malformed clips and bounds valid records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lean-clip-state-"));
  try {
    const file = join(dir, "session.jsonl");
    const valid = Array.from({ length: 140 }, (_, i) => ({ id: `clip${i}`, fingerprint: "a".repeat(64), text: "[truncated for context space]" }));
    const state = { ...createInitialState(), emergencyTruncateLatch: [...valid, null, {}, { id: "bad", fingerprint: "wrong", text: "[truncated for context space]" }, { id: "not-clipped", fingerprint: "a".repeat(64), text: "full body" }] };
    await writeFile(`${file}.acp.json`, JSON.stringify(state), "utf8");
    const loaded = await new SessionStateStore().load(file, "test");
    assert.deepEqual(loaded.emergencyTruncateLatch, valid.slice(-128));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("truncation: unrelated successful folds and rejected folds preserve live clips", () => {
  const h = setup();
  const first = h.run(h.state, 96000);
  const bad = h.core.applyCompression({ messages: h.messages, state: first.state, config: h.config, ranges: [{ startRef: "bad", endRef: "bad", summary: "A detailed summary retaining the original findings and all pending decisions." }] });
  assert.ok(bad.result.errors.length > 0);
  assert.equal(body(h.run(bad.state, 60000).messages), body(first.messages));
  const good = h.core.applyCompression({ messages: h.messages, state: first.state, config: h.config, ranges: [{ startRef: "m00001", endRef: "m00001", summary: "A detailed summary retaining the original findings and all pending decisions." }] });
  // The warm-up is deliberately made large enough without touching the clipped message.
  assert.equal(good.result.blocksCreated, 1, good.result.errors.join("; "));
  assert.equal(body(h.run(good.state, 60000).messages), body(first.messages));
});

test("truncation: sent-view recount stays on the pre-clip scale to avoid deducting savings twice", () => {
  const h = setup();
  const first = h.run(h.state, 96000);
  const folded = h.core.applyCompression({ messages: h.messages, state: first.state, config: h.config, ranges: [{ startRef: "m00001", endRef: "m00001", summary: "A detailed summary retaining the original findings and all pending decisions." }] });
  assert.equal(folded.result.blocksCreated, 1, folded.result.errors.join("; "));
  const unclipped = { ...folded.state, emergencyTruncateLatch: undefined };
  const expected = sentViewTokenCount(h.core, h.messages, unclipped, h.config, 60000);
  const actual = sentViewTokenCount(h.core, h.messages, folded.state, h.config, 60000);
  assert.equal(actual.viewTokens, expected.viewTokens);
  assert.ok(folded.state.emergencyTruncateLatch?.some(e => e.id === "big"), "the counting probe must not mutate the live clip state");
});

test("truncation: folding the clipped message retires only its own clip", () => {
  const h = setup();
  const other: CoreMessage = { id: "other", role: "assistant", contentType: "text", text: "other-history ".repeat(4000) };
  const messages = [{ ...h.messages[0]!, text: "warm-up" }, h.messages[1]!, other, ...h.messages.slice(2)];
  const first = h.run(h.state, 200000, messages);
  assert.deepEqual(first.state.emergencyTruncateLatch?.map(e => e.id), ["big", "other"]);
  const folded = h.core.applyCompression({ messages, state: first.state, config: h.config, ranges: [{ startRef: first.state.messageRefs.byRaw.big!, endRef: first.state.messageRefs.byRaw.big!, summary: "A detailed summary retaining the original findings and all pending decisions." }] });
  assert.equal(folded.result.blocksCreated, 1, folded.result.errors.join("; "));
  assert.deepEqual(folded.state.emergencyTruncateLatch?.map(e => e.id), ["other"]);
  const next = h.run(folded.state, 60000, messages);
  assert.equal(body(next.messages, "other"), body(first.messages, "other"));
  assert.ok(!next.messages.some(m => m.id === "big"));
});
