import { test } from "node:test";
import assert from "node:assert/strict";
import { applyFoldAnchor, claudeFoldAnchorApplies, earliestRef } from "../src/fold-anchor.js";
import { resolveCompress } from "../src/config.js";

// Claude cache anchor (compress.claudeFoldAnchor): the anchor must sit
// before the earliest compressible range, never inside it.

test("claudeFoldAnchor applies by default, only on Claude over a responses API", () => {
  const claude = { api: "cliproxyapi-codex-responses", id: "claude-opus-5-5" };
  assert.equal(claudeFoldAnchorApplies(true, claude), true);
  assert.equal(claudeFoldAnchorApplies(undefined, claude), true, "on by default");
  assert.equal(claudeFoldAnchorApplies(undefined, { api: "cliproxyapi-codex-responses", id: "gpt-6-luna" }), false, "default never reaches other models");
  assert.equal(claudeFoldAnchorApplies(false, claude), false);
  assert.equal(claudeFoldAnchorApplies(true, { api: "cliproxyapi-codex-responses", id: "gpt-6-luna" }), false, "non-Claude model");
  assert.equal(claudeFoldAnchorApplies(true, { api: "anthropic-messages", id: "claude-opus-5-5" }), false, "non-responses API");
});

test("claudeFoldAnchor resolves global → provider → model, deepest defined value wins", () => {
  const compress = { claudeFoldAnchor: true, providers: { p: { models: { off: { claudeFoldAnchor: false } } } } };
  assert.equal(resolveCompress(compress, "p", "claude-opus-5-5").claudeFoldAnchor, true);
  assert.equal(resolveCompress(compress, "p", "off").claudeFoldAnchor, false);
  assert.equal(resolveCompress(undefined, "p", "claude-opus-5-5").claudeFoldAnchor, undefined);
});

const tag = (r: string) => `\n\n<acp tokens="3" type="text">${r}</acp>\n`;
const user = (text: string) => ({ role: "user", content: [{ type: "input_text", text }] });
const assistant = (text: string) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] });
const call = (id: string) => ({ type: "function_call", call_id: id, name: "read", arguments: "{}" });
const result = (id: string, r: string) => ({ type: "function_call_output", call_id: id, output: "file" + tag(r) });

function body() {
  return {
    model: "claude-haiku-5-5",
    input: [
      { role: "developer", content: "sys" },
      user("q1" + tag("m00001")),
      assistant("a1"),
      call("c1"),
      result("c1", "m00003"),
      assistant("a2 inside range"),
      call("c2"),
      result("c2", "m00005"),
    ],
  };
}

const marked = (b: unknown, i: number) => JSON.stringify((b as ReturnType<typeof body>).input[i]).includes("cache_control");

test("anchors the last text part before the range, not the untagged assistant inside it", () => {
  const src = body();
  const out = applyFoldAnchor(src, "m00004");
  assert.equal(out.index, 2);
  assert.ok(marked(out.body, 2));
  assert.ok(!marked(out.body, 5));
  assert.ok(!marked(src, 2), "input body must not be mutated");
});

test("skips when there is no range or no tagged item before it", () => {
  assert.equal(applyFoldAnchor(body(), undefined).reason, "no-range");
  assert.equal(applyFoldAnchor(body(), "m00001").reason, "no-boundary");
  assert.equal(applyFoldAnchor({ messages: [] }, "m00004").reason, "no-input");
});

test("a ref tag quoted mid-text does not count as the item's ref", () => {
  const src = body();
  // An untagged assistant inside the range quoting an old tag must not become the boundary.
  src.input[5] = assistant(`see ${tag("m00002").trim()} above`);
  const out = applyFoldAnchor(src, "m00004");
  assert.equal(out.index, 2);
});

test("leaves an already-marked anchor unchanged", () => {
  const src = body();
  (src.input[2].content as Array<Record<string, unknown>>)[0].cache_control = { type: "ephemeral" };
  const out = applyFoldAnchor(src, "m00004");
  assert.equal(out.reason, "already-marked");
  assert.equal(out.body, undefined);
});

test("earliestRef orders numerically across digit widths", () => {
  assert.equal(earliestRef(["m100000", "m99999", "m100001"]), "m99999");
  assert.equal(earliestRef([]), undefined);
});
