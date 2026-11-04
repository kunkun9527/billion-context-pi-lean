import { test } from "node:test";
import assert from "node:assert/strict";
import { assignRefs, createCore, createInitialState, defaultConfig, type CoreMessage } from "acp-kernel";

const summary = "A detailed summary retaining the original findings and decisions, long enough to pass the summary gate.";
function setup(n: number, recent: number, roles = (i: number): CoreMessage["role"] => i % 2 ? "user" : "assistant") {
  const core = createCore();
  const state = createInitialState();
  const messages: CoreMessage[] = Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, role: roles(i + 1), contentType: "text", text: `body ${i + 1} `.repeat(120) }));
  state.messageRefs = assignRefs(messages, { existing: state.messageRefs, nextIndex: 1 }).map;
  const config = defaultConfig(200000, { preserveRecentMessages: recent, preserveRecentTokens: 0 });
  return { core, state, messages, config };
}

test("#3953: an interior protected question keeps its later answers outside the fold", () => {
  const { core, ...input } = setup(10, 1, i => i > 7 ? "assistant" : i % 2 ? "user" : "assistant");
  const out = core.applyCompression({ ...input, ranges: [{ startRef: "m00002", endRef: "m00009", summary }] });
  assert.equal(out.result.blocksCreated, 1, out.result.errors.join("; "));
  assert.deepEqual(out.state.blocks[0]!.directMessageIds, ["p2", "p3", "p4", "p5", "p6"]);
  assert.deepEqual(out.state.blocks[0]!.effectiveMessageIds, ["p2", "p3", "p4", "p5", "p6"]);
  assert.match(out.result.warnings.join(" "), /truncated at that boundary/i);
  assert.equal(input.state.blocks.length, 0, "dry runs must not mutate caller state");
});

test("#3953: a tail-only protected brush retains the existing advisory behavior", () => {
  const { core, ...input } = setup(8, 2);
  const out = core.applyCompression({ ...input, ranges: [{ startRef: "m00002", endRef: "m00008", summary }] });
  assert.equal(out.result.blocksCreated, 1, out.result.errors.join("; "));
  assert.deepEqual(out.state.blocks[0]!.effectiveMessageIds, ["p2", "p3", "p4", "p5", "p6"]);
  assert.match(out.result.warnings.join(" "), /Excluded 2 protected message/);
  assert.doesNotMatch(out.result.warnings.join(" "), /truncated at that boundary/i);
});

test("#3953: a cut must not strand a tool call/result pair", () => {
  const { core, ...input } = setup(6, 1, i => i === 3 ? "user" : i === 4 ? "tool" : "assistant");
  for (const message of input.messages) message.text = (message.text ?? "").repeat(2);
  Object.assign(input.messages[1]!, { contentType: "tool-call", toolName: "bash", toolCallId: "pair" });
  Object.assign(input.messages[3]!, { contentType: "tool-result", toolName: "bash", toolCallId: "pair" });
  const out = core.applyCompression({ ...input, ranges: [{ startRef: "m00001", endRef: "m00005", summary }] });
  assert.equal(out.result.blocksCreated, 1, out.result.errors.join("; "));
  assert.deepEqual(out.state.blocks[0]!.effectiveMessageIds, ["p1", "p2", "p4", "p5"]);
  assert.doesNotMatch(out.result.warnings.join(" "), /truncated at that boundary/i);
});

test("#3953: a protected head still allows the remaining old messages to fold", () => {
  const { core, ...input } = setup(9, 1, i => i === 2 ? "user" : "assistant");
  const out = core.applyCompression({ ...input, ranges: [{ startRef: "m00002", endRef: "m00007", summary }] });
  assert.equal(out.result.blocksCreated, 1, out.result.errors.join("; "));
  assert.deepEqual(out.state.blocks[0]!.effectiveMessageIds, ["p3", "p4", "p5", "p6", "p7"]);
});
