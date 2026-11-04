import { after, test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { stream as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as responsesStream } from "@earendil-works/pi-ai/api/openai-responses";
import { createAcpExtension } from "../src/index.js";
import { applyFoldAnchors, prepareFoldAnchors } from "../src/fold-anchor-cache.js";
import { tmpPath } from "./tmp-path.js";

const proxyEnv = ["BILLION_CONTEXT_NATIVE", "BILLION_CONTEXT_PROXY", "BILI_NO_CACHE_CONTROL"] as const;
const savedProxyEnv = proxyEnv.map(key => process.env[key]);
for (const key of proxyEnv) delete process.env[key];
after(() => proxyEnv.forEach((key, i) => { if (savedProxyEnv[i] !== undefined) process.env[key] = savedProxyEnv[i]; }));

// Capture Pi's real provider serialization, stopping before any network call.
async function serialize(model: any, messages: any[]) {
  let payload: any;
  const stream = model.api === "anthropic-messages" ? anthropicStream : responsesStream;
  const result = stream(model, { messages: messages.filter(m => ["user", "assistant", "toolResult"].includes(m.role)), systemPrompt: "system" }, {
    apiKey: "test-key", onPayload: (body: unknown) => { payload = body; throw new Error("stop before network"); },
  });
  await result.result();
  assert.ok(payload, "Pi produced a provider payload");
  return payload;
}

for (const wire of ["anthropic", "responses"] as const) test(`real fold and Pi ${wire} request anchor survives a second request`, async () => {
  const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
  const api = { tools: [] as any[], on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }, registerTool(tool: any) { this.tools.push(tool); }, registerCommand() {} };
  createAcpExtension({ modelContextLimit: 200_000, preserveRecentMessages: 1 })(api as any);
  const stateFile = tmpPath(`fold-anchor-${wire}.session.json`);
  await rm(`${stateFile}.acp.json`, { force: true });
  const entries = Array.from({ length: 5 }, (_, i) => ({ type: "message", id: `e${i + 1}`, parentId: null, timestamp: "", message: { role: "user", content: `message ${i + 1} ${"中".repeat(6000)}`, timestamp: i } }));
  const model: any = { id: "test-model", name: "test-model", api: wire === "anthropic" ? "anthropic-messages" : "openai-responses", provider: wire === "anthropic" ? "anthropic" : "github-copilot", baseUrl: wire === "anthropic" ? "https://api.anthropic.com" : "https://api.githubcopilot.com", contextWindow: 200_000, maxTokens: 4096, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const ctx: any = { mode: "rpc", hasUI: false, model, ui: { notify() {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus() {} }, sessionManager: { buildContextEntries: () => entries, getSessionId: () => "fold-test", getSessionFile: () => stateFile } };
  const context = handlers.get("context")![0]!;
  const before = handlers.get("before_provider_request")![0]!;
  const run = () => context({ type: "context", messages: [] }, ctx);
  try {
    const unfolded = await run();
    assert.equal(await before({ payload: await serialize(model, unfolded.messages) }, ctx), undefined, "no extra breakpoint before any fold");
    const compress = api.tools.find(t => t.name === "compress");
    const result = await compress.execute("fold", { content: [{ startId: "m00002", endId: "m00002", summary: "This message has been folded into a meaningful summary." }] }, undefined, undefined, ctx);
    assert.match(result.content[0].text, /blocks: b\d+=/, result.content[0].text);
    const first = await run();
    const request = await serialize(model, first.messages);
    const anchored = await before({ payload: request }, ctx);
    assert.ok(anchored, "an anchor was inserted after a real fold");
    const field = wire === "anthropic" ? "messages" : "input";
    const marker = wire === "anthropic" ? "cache_control" : "prompt_cache_breakpoint";
    const firstItem = anchored[field].find((item: any) => JSON.stringify(item).includes("m00001"));
    assert.ok(firstItem && JSON.stringify(firstItem).includes(marker), "the breakpoint is on the message before the folded range");
    const second = await run();
    const again = await before({ payload: await serialize(model, second.messages) }, ctx);
    assert.deepEqual(again[field][0], anchored[field][0], "the anchored prefix is byte-stable");
    const forward = await compress.execute("fold-forward", { content: [{ startId: "m00004", endId: "m00004", summary: "This later message is folded to test a forward fold." }] }, undefined, undefined, ctx);
    assert.match(forward.content[0].text, /blocks: b\d+=/, forward.content[0].text);
    const later = await run();
    const laterAnchored = await before({ payload: await serialize(model, later.messages) }, ctx);
    const laterItem = laterAnchored[field].find((item: any) => JSON.stringify(item).includes("m00003"));
    assert.ok(laterItem && JSON.stringify(laterItem).includes(marker), "the new fold has an anchor");
    if (wire === "responses") assert.deepEqual(laterAnchored[field].find((item: any) => JSON.stringify(item).includes("m00001")), firstItem, "the earlier Responses anchor remains stable");
    const switched = { ...ctx, model: { ...model, id: "different-model" } };
    assert.equal(await before({ payload: request }, switched), undefined, "no stale snapshot after a model switch");
    const switchedProvider = { ...ctx, model: { ...model, provider: "different-provider" } };
    assert.equal(await before({ payload: request }, switchedProvider), undefined, "no stale ID mapping after a provider switch");
    await handlers.get("session_shutdown")![0]!({}, ctx);
    assert.equal(await before({ payload: request }, ctx), undefined, "no snapshot after shutdown");
  } finally { await rm(`${stateFile}.acp.json`, { force: true }); }
});

for (const wire of ["anthropic", "responses"] as const) test(`tool-result anchor matches Pi's actual ${wire} ID serialization`, async () => {
  const model: any = { id: "current", name: "current", api: wire === "anthropic" ? "anthropic-messages" : "openai-responses", provider: wire === "anthropic" ? "anthropic" : "github-copilot", baseUrl: wire === "anthropic" ? "https://api.anthropic.com" : "https://api.githubcopilot.com", contextWindow: 200_000, maxTokens: 4096, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const ids = wire === "anthropic" ? ["call_1", "call:1"] : ["call", "call|fc_x"];
  const source = wire === "anthropic" ? { api: model.api, provider: model.provider, model: model.id } : { api: "openai-responses", provider: "openai", model: "old" };
  const assistant = { role: "assistant", ...source, content: ids.map(id => ({ type: "toolCall", id, name: "run", arguments: {} })), stopReason: "toolUse", timestamp: 1 };
  const messages = [assistant, ...ids.map((id, i) => ({ role: "toolResult", toolCallId: id, toolName: "run", content: [{ type: "text", text: `result ${i} [m0000${i + 1}]` }], isError: false, timestamp: 2 })), { role: "user", content: "later", timestamp: 3 }];
  const core: any[] = [
    ...ids.map((id, i) => ({ id: `a#${i}`, role: "assistant", contentType: "tool-call", toolCallId: id })),
    ...ids.map((id, i) => ({ id: `r${i}`, role: "tool", contentType: "tool-result", toolCallId: id })),
    { id: "hidden", role: "user", contentType: "text", text: "later" },
  ];
  const anchors = prepareFoldAnchors(core, core.slice(0, -1), [{ active: true, createdAt: 1, effectiveMessageIds: ["hidden"] } as any], { r1: "m00002" }, new Map([["a", assistant]]), wire, model);
  const marked: any = applyFoldAnchors(await serialize(model, messages), wire, anchors);
  assert.ok(marked);
  if (wire === "anthropic") {
    const results = marked.messages.find((item: any) => Array.isArray(item.content) && item.content.some((part: any) => part.type === "tool_result"));
    assert.equal(results.content[0].cache_control, undefined);
    assert.deepEqual(results.content[1].cache_control, { type: "ephemeral" });
  } else {
    const results = marked.input.filter((item: any) => item.type === "function_call_output");
    assert.equal(results[0].call_id, "call");
    assert.equal(results[0].output.includes("prompt_cache_breakpoint"), false);
    assert.equal(results[1].call_id, "call_fc_x");
    assert.deepEqual(results[1].output[0].prompt_cache_breakpoint, { mode: "explicit" });
  }
});
