import { test } from "node:test";
import assert from "node:assert/strict";
import { applyFoldAnchor, earliestRef } from "../src/fold-anchor.js";

// Experimental Claude cache anchor (ACP_FOLD_ANCHOR=1): the anchor must sit
// before the earliest compressible range, never inside it.

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
