import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const extensionModule = await jiti.import("../index.ts");
const extension = extensionModule.default ?? extensionModule;
const { createLeanAcpExtension } = extensionModule;

function createPi() {
  const tools = [];
  const handlers = new Map();
  const noOp = () => undefined;
  return new Proxy({
    tools,
    handlers,
    registerTool(tool) {
      tools.push(tool);
    },
    on(event, handler) {
      const listeners = handlers.get(event) ?? [];
      listeners.push(handler);
      handlers.set(event, listeners);
    },
    registerCommand: noOp,
    registerShortcut: noOp,
    registerMessageRenderer: noOp,
    registerProvider: noOp,
    registerFlag: noOp,
    getFlag: () => undefined,
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: noOp,
    appendEntry: noOp,
    sendMessage: noOp,
    events: { on: noOp, emit: noOp },
  }, {
    get(target, property) {
      return property in target ? target[property] : noOp;
    },
  });
}

const schemas = {
  compress: {
    type: "object",
    description: "large outer description",
    properties: {
      topic: { type: "string", description: "large top-level topic description" },
      content: {
        type: "array",
        description: "large nested description",
        items: {
          type: "object",
          properties: {
            startId: { type: "string", description: "large start description" },
            endId: { type: "string", description: "large end description" },
            summary: { type: "string", description: "large summary description" },
            topic: { type: "string", description: "large range topic description" },
          },
        },
      },
      summaryMaxChars: { type: "number", description: "large limit description" },
    },
    required: ["content"],
  },
  decompress: {
    type: "object",
    properties: {
      blockId: { type: "string" },
      full: { type: "boolean" },
      toFile: { type: "string" },
      inline: { type: "boolean" },
    },
    required: ["blockId"],
  },
  search_context: {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "number" },
    },
    required: ["query"],
  },
  acp_status: {
    type: "object",
    properties: {
      scope: { type: "string" },
      view: { type: "string" },
      tool: { type: "string" },
      sort: { type: "string" },
      limit: { type: "number" },
    },
  },
};

function fakeUpstream(calls = [], executions = { count: 0 }) {
  return (pi) => {
    for (const name of ["compress", "decompress", "search_context", "acp_status"]) {
      pi.registerTool({
        name,
        label: name,
        description: `${name} full upstream description`,
        parameters: structuredClone(schemas[name]),
        async execute(...args) {
          executions.count += 1;
          calls.push([name, ...args]);
          return {
            content: [{
              type: "text",
              text: name === "search_context"
                ? 'result → decompress({ blockId: "b12" })'
                : name === "compress"
                  ? 'Nothing to do — Run acp_status, then call compress again. Use search_context or decompress to retrieve details. Try search_context({ query: "auth token" }).'
                  : `${name} result`,
            }],
          };
        },
      });
    }
    pi.registerTool({ name: "acp_delegate", async execute() {} });
    pi.on("before_agent_start", () => ({ systemPrompt: "upstream prompt must be suppressed" }));
  };
}

function getTool(pi, name) {
  return pi.tools.find((tool) => tool.name === name);
}

test("registers only compress and acp_context provider tools", () => {
  const pi = createPi();
  createLeanAcpExtension(fakeUpstream())(pi);
  assert.deepEqual(pi.tools.map((tool) => tool.name), ["compress", "acp_context"]);
});

test("keeps compress direct, retains concise critical descriptions, and rewrites stale status advice", async () => {
  const calls = [];
  const pi = createPi();
  createLeanAcpExtension(fakeUpstream(calls))(pi);
  const tool = getTool(pi, "compress");
  const result = await tool.execute(
    "compress-1",
    { content: [{ startId: "m1", endId: "m2", summary: "done" }] },
    undefined,
    undefined,
    { cwd: "C:/work" },
  );

  const schema = tool.parameters;
  const entries = schema.properties.content.items.properties;
  assert.equal(schema.description, undefined);
  assert.equal(schema.properties.content.description, undefined);
  assert.match(schema.properties.topic.description, /label/i);
  assert.match(schema.properties.summaryMaxChars.description, /length/i);
  assert.match(entries.startId.description, /first/i);
  assert.match(entries.endId.description, /last/i);
  assert.match(entries.summary.description, /exact technical details/i);
  assert.match(entries.topic.description, /label/i);
  assert.doesNotMatch(JSON.stringify(schema), /large .* description/);
  const rewritten = result.content[0].text;
  assert.match(rewritten, /acp_context\(\{ op: "acp_status", args: \{\} \}\)/);
  assert.match(rewritten, /use acp_context with op "search_context" or "decompress"/i);
  assert.match(rewritten, /acp_context\(\{ op: "search_context", args: \{ query: "auth token" \} \}\)/);
  assert.doesNotMatch(rewritten, /\b(?:search_context|decompress|acp_status)\s*\(/);
  assert.doesNotMatch(rewritten, /\brun acp_status\b/i);
  assert.doesNotMatch(rewritten, /\buse search_context\b/i);
  assert.equal(calls[0][0], "compress");
  assert.deepEqual(calls[0][2], { content: [{ startId: "m1", endId: "m2", summary: "done" }] });
});
test("routes all three low-frequency operations with original args and execution context", async () => {
  const cases = [
    ["search_context", { query: "architecture", limit: 8 }],
    ["decompress", { blockId: "b11", toFile: "R:/Temp/history.txt", full: true }],
    ["acp_status", { scope: "uncompressed", view: "messages", sort: "size", limit: 30 }],
  ];

  for (const [op, args] of cases) {
    const calls = [];
    const pi = createPi();
    createLeanAcpExtension(fakeUpstream(calls))(pi);
    const signal = new AbortController().signal;
    const context = { cwd: "C:/work" };
    await getTool(pi, "acp_context").execute(
      `call-${op}`,
      { op, args },
      signal,
      undefined,
      context,
    );
    assert.equal(calls[0][0], op);
    assert.equal(calls[0][1], `call-${op}`);
    assert.deepEqual(calls[0][2], args);
    assert.equal(calls[0][3], signal);
    assert.equal(calls[0][5], context);
  }
});

test("rewrites search results to the facade call syntax", async () => {
  const pi = createPi();
  createLeanAcpExtension(fakeUpstream())(pi);
  const result = await getTool(pi, "acp_context").execute(
    "search-1",
    { op: "search_context", args: { query: "needle" } },
  );
  assert.equal(
    result.content[0].text,
    'result → acp_context({ op: "decompress", args: { blockId: "b12" } })',
  );
});

test("facade advertises help syntax and discloses an upstream schema without executing it", async () => {
  const executions = { count: 0 };
  const pi = createPi();
  createLeanAcpExtension(fakeUpstream([], executions))(pi);
  const tool = getTool(pi, "acp_context");
  assert.match(
    tool.description,
    /\{ op: "help", args: \{ tool: "search_context" \} \}/,
  );
  const result = await tool.execute(
    "help-1",
    { op: "help", args: { tool: "decompress" } },
  );
  assert.equal(executions.count, 0);
  assert.match(result.content[0].text, /blockId/);
  assert.match(result.content[0].text, /toFile/);
});

test("invalid facade args fail locally with an on-demand help hint", async () => {
  const executions = { count: 0 };
  const pi = createPi();
  createLeanAcpExtension(fakeUpstream([], executions))(pi);
  await assert.rejects(
    getTool(pi, "acp_context").execute(
      "invalid-1",
      { op: "decompress", args: { inline: true } },
    ),
    /args invalid.*op help.*decompress/,
  );
  assert.equal(executions.count, 0);
});

test("suppresses the upstream prompt and keeps concise summary-fidelity rules", async () => {
  const pi = createPi();
  createLeanAcpExtension(fakeUpstream())(pi);
  const hooks = pi.handlers.get("before_agent_start");
  assert.equal(hooks.length, 1);
  const result = await hooks[0]({ systemPrompt: "base prompt" });
  assert.match(result.systemPrompt, /^base prompt/);
  assert.match(result.systemPrompt, /Compress consumed history with compress/);
  assert.match(result.systemPrompt, /exact file paths and line numbers/i);
  assert.match(result.systemPrompt, /symbols and signatures/i);
  assert.match(result.systemPrompt, /errors, commands, versions, thresholds/i);
  assert.match(result.systemPrompt, /decisions with reasons, current state, and unresolved TODOs/i);
  assert.match(result.systemPrompt, /Refs may be renumbered after compression/i);
  assert.match(result.systemPrompt, /Block decompression writes to a file by default/i);
  assert.match(result.systemPrompt, /provider-throttle.*resume exactly where interrupted/i);
  assert.match(result.systemPrompt, /acp_context/);
  assert.doesNotMatch(result.systemPrompt, /upstream prompt must be suppressed/);
});

test("real upstream registration exposes the intended two-tool surface", () => {
  const pi = createPi();
  extension(pi);
  assert.deepEqual(pi.tools.map((tool) => tool.name), ["compress", "acp_context"]);
});

test("provider-facing metadata stays within the lean budget", () => {
  const pi = createPi();
  extension(pi);
  const metadata = pi.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    promptSnippet: tool.promptSnippet,
    promptGuidelines: tool.promptGuidelines,
  }));
  const serialized = JSON.stringify(metadata);
  assert.ok(
    serialized.length <= 1450,
    `lean metadata grew to ${serialized.length} characters`,
  );
});
