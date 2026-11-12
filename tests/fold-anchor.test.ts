import { test } from "node:test";
import assert from "node:assert/strict";
import { applyFoldAnchor, claudeFoldAnchorApplies, earliestRef } from "../src/fold-anchor.js";
import { resolveCompress } from "../src/config.js";
import { createAcpExtension } from "../src/index.js";
import { rm } from "node:fs/promises";
import { tmpPath } from "./tmp-path.js";

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

test("a start ref already folded out of the payload still anchors before where it was", () => {
  const src = body();
  src.input.splice(3, 2); // m00003's call/result folded away; start m00003 no longer appears
  const out = applyFoldAnchor(src, "m00003");
  assert.equal(out.index, 1, "anchored at the last tagged item below the folded start");
  assert.ok(marked(out.body, 1));
});

test("earliestRef orders numerically across digit widths", () => {
  assert.equal(earliestRef(["m100000", "m99999", "m100001"]), "m99999");
  assert.equal(earliestRef([]), undefined);
});

// ─── Sticky start through the extension hooks ──────────────────────────────
// After the last fold no viable range remains, but the prefix before the
// previous start is unchanged and was cached by the previous request — the
// anchor must stay there instead of dropping (cacheRead fell 70K → 10.5K in a
// real session when it dropped). /tree and session start reset it.

function captureApi() {
  const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
  const api = {
    on(event: string, handler: (e: any, ctx: any) => any) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    tools: [] as any[],
    commands: new Map<string, any>(),
    registerTool(tool: any) { this.tools.push(tool); },
    registerCommand(name: string, options: any) { this.commands.set(name, options); },
  };
  return { api, handlers };
}

function hookCtx(entries: any[], stateFile: string) {
  return {
    mode: "rpc",
    hasUI: false,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000, id: "claude-test", api: "test-responses", provider: "p" },
    getContextUsage: () => ({ tokens: 100_000, percent: 50 }),
    sessionManager: {
      buildContextEntries: () => entries,
      getSessionId: () => "fold-anchor-sticky",
      getSessionFile: () => stateFile,
    },
  };
}

const entry = (id: string, text: string) => ({ type: "message", id, parentId: null, timestamp: "", message: { role: "user", content: text, timestamp: Date.now() } });

// Wire payload: item 1 carries ref m00001, item 2 is past every start used here.
const wire = () => ({ model: "claude-test", input: [{ role: "developer", content: "sys" }, user("q1" + tag("m00001")), user("later" + tag("m00009"))] });

test("anchor start is sticky when no range remains, and resets on /tree and session start", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000, preserveRecentMessages: 1 })(api as any);
  const stateFile = tmpPath("pai-acp-fold-anchor-sticky.session.json");
  await rm(`${stateFile}.acp.json`, { force: true });
  const BIG = "中".repeat(6000);
  const ctx = hookCtx([entry("e1", BIG), entry("e2", BIG), entry("e3", BIG)], stateFile);
  const context = () => handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);
  const send = async (payload: any = wire()) => {
    const out = await handlers.get("before_provider_request")![0]!({ type: "before_provider_request", payload }, ctx);
    assert.ok(!JSON.stringify(payload).includes("cache_control"), "raw payload must not be mutated");
    return out;
  };
  const compress = async (id: string, startId: string, endId: string) => {
    const tool = api.tools.find((t: any) => t.name === "compress")!;
    const out = await tool.execute(id, { content: [{ startId, endId, summary: `folded ${startId}-${endId} for the sticky anchor test with enough summary length` }] }, undefined, undefined, ctx);
    const text = typeof out === "string" ? out : out.content?.[0]?.text ?? String(out);
    assert.match(text, /blocks: b\d+=/, text);
  };

  await context();
  await compress("tc1", "m00001", "m00001");
  await context(); // earliest viable start is now m00002
  assert.ok(marked(await send(), 1), "anchor before m00002 marks the m00001 item");

  for (const h of handlers.get("session_start") ?? []) await h({ type: "session_start" }, ctx);
  assert.equal(await send(), undefined, "session start drops the remembered start");
  await context();
  assert.ok(marked(await send(), 1), "the next turn records the start again");

  await compress("tc2", "m00002", "m00003");
  await context(); // nothing viable remains
  assert.ok(marked(await send(), 1), "no range left: keep the previous start");
  // The kept start is rescanned against each payload, not a saved index.
  const shifted = wire();
  shifted.input.splice(1, 0, user("earlier" + tag("m00000")) as any);
  assert.ok(marked(await send(shifted), 2), "a changed prefix moves the anchor with the m00001 item");

  for (const h of handlers.get("session_tree") ?? []) await h({ type: "session_tree" }, ctx);
  assert.equal(await send(), undefined, "/tree drops the remembered start");
  await rm(`${stateFile}.acp.json`, { force: true });
});
