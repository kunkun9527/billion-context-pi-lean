import { test } from "node:test";
import assert from "node:assert/strict";
import { applyFoldAnchors, foldAnchorMessageIds, foldAnchorPolicy, prepareFoldAnchors } from "../src/fold-anchor-cache.js";

const user = (id: string) => ({ id, role: "user" as const, contentType: "text" as const, text: id });
const block = (ids: string[], createdAt = 1, active = true) => ({ active, createdAt, effectiveMessageIds: ids });
const mark = { type: "ephemeral" };

test("fold anchor selection follows hidden messages, split IDs, order and cap", () => {
  const messages = [user("a"), user("b#one"), user("b#two"), user("c"), user("d"), user("e")];
  const visible = [messages[0]!, messages[1]!, messages[3]!, messages[5]!];
  assert.deepEqual(foldAnchorMessageIds(messages, visible, [block(["b#one"]), block(["d"], 2), block(["e"], 3, false)], 40, () => true), ["c", "b#one"]);
  assert.deepEqual(foldAnchorMessageIds(messages, messages, [block(["b#two"])], 40, () => true), []);
  const many = Array.from({ length: 44 }, (_, i) => user(String(i)));
  const blocks = Array.from({ length: 21 }, (_, i) => block([String(i * 2 + 1)], i));
  const selected = foldAnchorMessageIds(many, many.filter((_, i) => i % 2 === 0), blocks, 5, () => true);
  assert.deepEqual(selected, ["40", "38", "36", "2", "0"]);
});

test("policies allow only the validated provider endpoints and honor the kill switch", () => {
  const old = process.env.BILI_NO_CACHE_CONTROL;
  delete process.env.BILI_NO_CACHE_CONTROL;
  try {
    assert.equal(foldAnchorPolicy("anthropic-messages", "https://api.anthropic.com/v1"), "anthropic");
    assert.equal(foldAnchorPolicy("anthropic-messages", "https://api.githubcopilot.com"), "anthropic");
    assert.equal(foldAnchorPolicy("openai-responses", "https://api.githubcopilot.com"), "responses");
    for (const [api, url] of [["openai-responses", "https://api.openai.com"], ["openai-codex-responses", "https://api.githubcopilot.com"], ["anthropic-messages", "https://anthropic.com.evil.test"], ["anthropic-messages", "bad url"]]) {
      assert.equal(foldAnchorPolicy(api, url), undefined);
    }
    process.env.BILI_NO_CACHE_CONTROL = "1";
    assert.equal(foldAnchorPolicy("anthropic-messages", "https://api.anthropic.com"), undefined);
  } finally { if (old === undefined) delete process.env.BILI_NO_CACHE_CONTROL; else process.env.BILI_NO_CACHE_CONTROL = old; }
});

test("Anthropic picks the last newest fold, even when it has no anchor", () => {
  const original = [user("a"), user("b"), user("c")];
  const originals = new Map(original.map(m => [m.id, { role: "user", content: m.text }]));
  const blocks = [block(["b"], 1), block(["a"], 1)] as any;
  assert.deepEqual(prepareFoldAnchors(original, [original[2]!], blocks, {}, originals, "anthropic", {}), []);
});

test("Anthropic preserves TTLs, budget and original objects", () => {
  const anchor = [{ role: "user" as const, ref: "m00001" }];
  const payload = { system: [{ type: "text", text: "system", cache_control: { type: "ephemeral", ttl: "1h" } }], tools: [{ name: "tool", cache_control: { type: "ephemeral", ttl: "1h" } }], messages: [{ role: "user", content: [{ type: "text", text: "[m00001] hello" }] }, { role: "user", content: [{ type: "text", text: "tail", cache_control: { type: "ephemeral", ttl: "1h" } }] }] };
  const snapshot = structuredClone(payload);
  const out = applyFoldAnchors(payload, "anthropic", anchor) as any;
  assert.deepEqual(out.messages[0].content[0].cache_control, { type: "ephemeral", ttl: "1h" });
  assert.deepEqual(payload, snapshot);
  const mixed = structuredClone(payload); mixed.messages[1]!.content[0]!.cache_control = mark as any;
  assert.equal(applyFoldAnchors(mixed, "anthropic", anchor), undefined);
  const full = { ...payload, cache_control: mark };
  assert.equal(applyFoldAnchors(full, "anthropic", anchor), undefined);
  const already = { messages: [{ role: "user", content: [{ type: "text", text: "[m00001] hello", cache_control: mark }] }] };
  assert.equal(applyFoldAnchors(already, "anthropic", anchor), undefined);
});

test("Anthropic locates assistant tool uses and grouped tool results, rejecting ambiguity", () => {
  const input = { messages: [{ role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "bash", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "output" }, { type: "tool_result", tool_use_id: "call_2", content: "output" }] }] };
  const tool = applyFoldAnchors(input, "anthropic", [{ role: "tool", callId: "call_2" }]) as any;
  assert.deepEqual(tool.messages[1].content[1].cache_control, mark);
  const call = applyFoldAnchors(input, "anthropic", [{ role: "assistant", callId: "call_1" }]) as any;
  assert.deepEqual(call.messages[0].content[0].cache_control, mark);
  const duplicate = { messages: [input.messages[0], input.messages[0]] };
  assert.equal(applyFoldAnchors(duplicate, "anthropic", [{ role: "assistant", callId: "call_1" }]), undefined);
  assert.equal(applyFoldAnchors({ messages: [{ role: "user", content: "same" }] }, "anthropic", [{ role: "user", ref: "m00001", text: "same" }]), undefined);
});

test("Copilot Responses marks user and tool outputs, only text and without mutating", () => {
  const input = { input: [{ role: "user", content: "[m00001] hello" }, { type: "function_call_output", call_id: "call_2", output: [{ type: "input_text", text: "out" }, { type: "input_image", image_url: "x" }] }] };
  const before = structuredClone(input);
  const out = applyFoldAnchors(input, "responses", [{ role: "user", ref: "m00001" }, { role: "tool", callId: "call_2" }]) as any;
  assert.deepEqual(out.input[0].content[0].prompt_cache_breakpoint, { mode: "explicit" });
  assert.deepEqual(out.input[1].output[0].prompt_cache_breakpoint, { mode: "explicit" });
  assert.deepEqual(input, before);
  const imagesOnly = { input: [{ type: "function_call_output", call_id: "call_2", output: [{ type: "input_image", image_url: "x" }] }] };
  assert.equal(applyFoldAnchors(imagesOnly, "responses", [{ role: "tool", callId: "call_2" }]), undefined);
});

test("tool anchors follow Pi's same-model and cross-model ID serialization and reject collisions", () => {
  const model = { api: "openai-responses", provider: "github-copilot", id: "current" };
  const call = (id: string, raw: string) => ({ id, role: "assistant", contentType: "tool-call", toolCallId: raw });
  const result = (id: string, raw: string) => ({ id, role: "tool", contentType: "tool-result", toolCallId: raw });
  const old = { role: "assistant", api: "openai-responses", provider: "openai", model: "old" };
  const core: any[] = [call("a#1", "call"), call("b#1", "call|fc_x"), result("r", "call|fc_x"), user("hidden")];
  const originals = new Map<string, unknown>([["a", old], ["b", old]]);
  const anchors = prepareFoldAnchors(core, core.slice(0, -1), [block(["hidden"]) as any], { r: "m00003" }, originals, "responses", model);
  assert.deepEqual(anchors, [{ role: "tool", callId: "call_fc_x", ref: "m00003" }]);
  const input = { input: [{ type: "function_call_output", call_id: "call", output: "wrong" }, { type: "function_call_output", call_id: "call_fc_x", output: "right [m00003]" }] };
  const out = applyFoldAnchors(input, "responses", anchors) as any;
  assert.equal(out.input[0].output, "wrong");
  assert.deepEqual(out.input[1].output[0].prompt_cache_breakpoint, { mode: "explicit" });
  assert.equal(applyFoldAnchors({ input: [{ type: "function_call_output", call_id: "call_fc_x", output: "No result provided" }] }, "responses", anchors), undefined, "synthetic results are not anchors");

  const anthropic = { api: "anthropic-messages", provider: "anthropic", id: "current" };
  const same = { role: "assistant", api: anthropic.api, provider: anthropic.provider, model: anthropic.id };
  const calls: any[] = [call("a#1", "call_1"), call("b#1", "call:1"), user("hidden")];
  const sources = new Map<string, unknown>([["a", same], ["b", same]]);
  const sameAnchors = prepareFoldAnchors(calls, calls.slice(0, -1), [block(["hidden"]) as any], {}, sources, "anthropic", anthropic);
  assert.deepEqual(sameAnchors, [{ role: "assistant", callId: "call:1" }]);
  const payload = { messages: [{ role: "assistant", content: [{ type: "tool_use", id: "call_1" }, { type: "tool_use", id: "call:1" }] }] };
  const marked = applyFoldAnchors(payload, "anthropic", sameAnchors) as any;
  assert.equal(marked.messages[0].content[0].cache_control, undefined);
  assert.deepEqual(marked.messages[0].content[1].cache_control, mark);
  const foreign = new Map<string, unknown>([["a", old], ["b", old]]);
  assert.deepEqual(prepareFoldAnchors(calls, calls.slice(0, -1), [block(["hidden"]) as any], {}, foreign, "anthropic", anthropic), [], "IDs that collide after cross-model normalization are not used");
});
