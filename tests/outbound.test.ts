import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { entriesToCoreMessages, extractText } from "../src/messages.js";
import { prepareHistoryForSend, finalizeOutboundMessages } from "../src/outbound.js";
import { countThinkingChars } from "../src/reasoning-drop.js";
import { createAcpExtension } from "../src/index.js";

type AgentMessage = SessionMessageEntry["message"];
const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 0 });
const assistant = (content: unknown[]): AgentMessage => ({ role: "assistant", content, timestamp: 0 } as AgentMessage);
const result = (toolCallId: string): AgentMessage => ({ role: "toolResult", toolName: "compress", toolCallId, content: [{ type: "text", text: "ok" }], timestamp: 0 } as AgentMessage);
const entry = (id: string, message: AgentMessage): SessionMessageEntry => ({ type: "message", id, parentId: null, timestamp: "", message });
function prepare(entries: SessionEntry[]) {
  return prepareHistoryForSend({ messages: entriesToCoreMessages(entries), entries, blocks: [], reasoningDrop: { drop: true, threshold: 0 }, degenerationGuard: false });
}

function inFlightEntries() {
  return [
    entry("u", user("go")),
    entry("a", assistant([{ type: "text", text: "compressing" }, { type: "thinking", thinking: "x".repeat(4096) }, { type: "toolCall", id: "c", name: "compress", arguments: {} }])),
    entry("r", result("c")),
  ];
}

test("synthetic nudges and host tails cannot close a persisted in-flight compress round", () => {
  const entries = inFlightEntries();
  const before = structuredClone(entries);
  const history = prepare(entries);
  const nudge = user("synthetic nudge");
  const tail = user("host instruction");
  const out = finalizeOutboundMessages({ messages: [...history.messages, nudge], liveMessages: [], liveTail: [tail], hasCompression: true });
  assert.equal(countThinkingChars(out.messages), 4096);
  assert.equal(history.droppedThinkingChars, 0);
  assert.deepEqual(out.messages.slice(-2), [nudge, tail]);
  assert.deepEqual(entries, before, "persisted history is never rewritten");
  const closed = prepare([...entries, entry("next", user("real continuation"))]);
  assert.equal(closed.droppedThinkingChars, 4096);
  assert.equal(countThinkingChars(closed.messages), 0);
});

test("thinking-only aborted originals still generate a self-limiting recovery notice", () => {
  const entries = [entry("u", user("go")), entry("a", assistant([{ type: "thinking", thinking: "【".repeat(500) }]))];
  const messages = entriesToCoreMessages(entries);
  assert.equal(messages.some((m) => m.id === "a"), false, "projection omits the textless assistant");
  const out = prepareHistoryForSend({ messages, entries, blocks: [], reasoningDrop: { drop: true }, degenerationGuard: { minRun: 100 } });
  assert.equal(out.recoveryRun?.count, 500);
  assert.equal(out.messages.length, 2, "user plus recovery notice, without the textless assistant");
  const continued = [...entries, entry("next", assistant([{ type: "text", text: "recovered" }]))];
  const next = prepareHistoryForSend({ messages: entriesToCoreMessages(continued), entries: continued, blocks: [], reasoningDrop: { drop: true }, degenerationGuard: { minRun: 100 } });
  assert.equal(next.recoveryRun, undefined);
});

test("final pairing sees host-tail calls/results and preserves the host toolset", () => {
  const sys = { role: "system", content: "pi", toolsAdded: [{ name: "read" }] } as unknown as AgentMessage;
  const original = [user("go")];
  const hostCall = assistant([{ type: "toolCall", id: "host", name: "read", arguments: {} }]);
  const valid = result("host");
  const orphan = result("missing");
  const liveTail = [hostCall, valid, orphan];
  const out = finalizeOutboundMessages({ messages: original, liveMessages: [sys], liveTail, hasCompression: true });
  assert.deepEqual(out.messages, [sys, ...original, hostCall, valid]);
  assert.equal(out.messages[0], sys);
  assert.equal(out.appendedTail, 3);
  assert.equal(out.carriedSystems, 1);
  assert.deepEqual(out.droppedResults, ["missing"]);
  assert.equal(original.length, 1);
  assert.equal(liveTail.length, 3);
});

test("uncompressed branches keep a leading result without a visible call", () => {
  const messages = [result("branch-parent"), user("continue")];
  const out = finalizeOutboundMessages({ messages, liveMessages: [], liveTail: null, hasCompression: false });
  assert.equal(out.messages, messages);
  assert.deepEqual(out.droppedResults, []);
});

test("history extraction retains custom-user projection and full summary arguments without editing the log", () => {
  const summary = "Detailed summary with exact paths and completed outcomes. ".repeat(10);
  const entries: SessionEntry[] = [
    { type: "custom_message", id: "custom", parentId: null, timestamp: "", customType: "host", content: "host note", display: true },
    entry("call", assistant([{ type: "toolCall", name: "compress", id: "c", arguments: { content: [{ startId: "m00001", endId: "m00001", summary: "short stub" }] } }])),
  ];
  const before = structuredClone(entries);
  const out = prepareHistoryForSend({ messages: entriesToCoreMessages(entries), entries, blocks: [{ blockId: "b1", active: true, compressCallId: "c", startRef: "m00001", endRef: "m00001", summary } as any], reasoningDrop: { drop: false }, degenerationGuard: false });
  assert.equal(out.messages[0]!.role, "user");
  assert.match(extractText(out.messages[0]!.content), /host note/);
  const call = (out.messages[1]!.content as any[]).find((p) => p.type === "toolCall");
  assert.equal(call.arguments.content[0].summary, summary);
  assert.deepEqual(entries, before);
});

test("status and panel cannot spend an overflow emergency before the actual send, which consumes it once", async () => {
  const entries = Array.from({ length: 9 }, (_, i) => entry(`e${i}`, user(`completed task ${i}: ` + "abcd ".repeat(1200))));
  const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
  const tools: any[] = [];
  const commands = new Map<string, any>();
  createAcpExtension({ modelContextLimit: 100_000, degenerationGuard: false })({
    on(name: string, handler: any) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
    registerTool(tool: any) { tools.push(tool); }, registerCommand(name: string, options: any) { commands.set(name, options); },
  } as any);
  const ctx: any = {
    cwd: process.cwd(), hasUI: false, ui: { notify() {} },
    model: { id: "test", contextWindow: 100_000, maxTokens: 20_000, api: "openai-completions" },
    sessionManager: { getSessionId: () => "armed-display-send", getSessionFile: () => undefined, buildContextEntries: () => entries },
    getContextUsage: () => null,
  };
  for (const h of handlers.get("message_end") ?? []) await h({ message: { role: "assistant", stopReason: "error", errorMessage: "maximum context length is 60000 tokens", content: [] } }, ctx);
  await tools.find((t) => t.name === "acp_status").execute("status", {}, undefined, undefined, ctx);
  (globalThis as Record<string, unknown>).CURRENT_VERSION ??= "0.0.0-test";
  await commands.get("acp").handler("", ctx);
  const event = { messages: entries.map((e) => e.message) };
  const send = handlers.get("context")![0]!;
  const emergencyCount = (out: any) => out.messages.filter((m: AgentMessage) => m.role === "user" && extractText(m.content).includes("Context limit reached")).length;
  assert.equal(emergencyCount(await send(event, ctx)), 1, "read-only paths leave the arm for the first actual send");
  assert.equal(emergencyCount(await send(event, ctx)), 0, "the second send must not inherit the consumed arm");
});

test("context wiring injects a real emergency nudge only after in-flight reasoning is checked", async () => {
  const entries = [
    // Leave enough completed history OUTSIDE the five-message protected tail,
    // and above the kernel's 5000-token minimum compression benefit.
    ...Array.from({ length: 6 }, (_, i) => entry(`old-${i}`, i % 2 ? assistant([{ type: "text", text: "finished work ".repeat(1000) }]) : user("old task ".repeat(1000)))),
    ...inFlightEntries(),
  ];
  const call = entries.find((e) => e.id === "a")!.message as any;
  call.usage = { input: 96_000, cacheRead: 0, cacheWrite: 0 };
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const api = { on: (name: string, handler: any) => handlers.set(name, handler), registerTool() {}, registerCommand() {} };
  createAcpExtension({ modelContextLimit: 100_000, degenerationGuard: false })(api as any);
  const ctx = {
    hasUI: false,
    model: { id: "test", contextWindow: 100_000 },
    sessionManager: { getSessionId: () => "outbound-order", getSessionFile: () => undefined, buildContextEntries: () => entries },
    getContextUsage: () => ({ tokens: 96_000, percent: 96 }),
  };
  const out = await handlers.get("context")!({ messages: entries.map((e) => e.message) }, ctx);
  assert.equal(countThinkingChars(out.messages), 4096);
  assert.equal(out.messages.filter((m: AgentMessage) => m.role === "user" && extractText(m.content).includes("Context limit reached")).length, 1, "one real emergency nudge was injected");
});
