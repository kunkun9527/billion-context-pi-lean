// lean 无 delegate 环境补丁的冒烟测试：
// 1) /acp-subagents 斜杠命令被拦截丢弃，其余命令保留；
// 2) acp_status 输出中已死的 delegate 用量尾行被过滤。
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

// jiti 现场加载 TypeScript 入口，绕开构建步骤（与 facade.test.mjs 同款做法）
const jiti = createJiti(import.meta.url, { moduleCache: false });
const extensionModule = await jiti.import("../index.ts");
const { createLeanAcpExtension } = extensionModule;

// 带 registerCommand 捕获的 pi mock：复刻 facade.test.mjs 的 createPi，
// 额外把命令注册记录进 commands Map 供断言使用
function createPi() {
  const tools = [];
  const commands = new Map();
  const handlers = new Map();
  const noOp = () => undefined;
  return new Proxy({
    tools,
    commands,
    handlers,
    registerTool(tool) {
      tools.push(tool);
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
    on(event, handler) {
      const listeners = handlers.get(event) ?? [];
      listeners.push(handler);
      handlers.set(event, listeners);
    },
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

// 模拟上游 billion-context-pi 的注册行为：四个 ACP 工具 + 五个斜杠命令
// （含 delegate 专属的 acp-subagents）+ delegate 工具 + 系统提示词 hook。
// acp_status 返回带 delegate 噪音尾行的真实形状文本。
function fakeUpstream(calls = []) {
  return (pi) => {
    for (const name of ["compress", "decompress", "search_context", "acp_status"]) {
      pi.registerTool({
        name,
        label: name,
        description: `${name} upstream description`,
        parameters: { type: "object", properties: {} },
        async execute(...args) {
          calls.push([name, ...args]);
          const text = name === "acp_status"
            ? [
              "ACP CONTEXT STATUS",
              "",
              "CONTEXT OVERVIEW",
              "Visible: 12.3k tok   Compressed: 0   Compressible: 1.1k tok",
              "Estimate: 12.3k (31%)   |   Provider-reported: 11.9k (30%)",
              "Nudge: idle — below distillation threshold",
              "",
              "Delegate usage: none this session.",
            ].join("\n")
            : `${name} result`;
          return { content: [{ type: "text", text }] };
        },
      });
    }
    // 上游 delegate 三件套：lean 必须继续拦掉
    pi.registerTool({ name: "acp_delegate", async execute() {} });
    // 上游命令注册：acp-subagents 仅服务于 pi-subagents 注入，应被丢弃
    pi.registerCommand("acp", { description: "ACP status" });
    pi.registerCommand("acp-status", { description: "Quick status" });
    pi.registerCommand("acp-subagents", { description: "delegate-only setup command" });
    pi.on("before_agent_start", () => ({ systemPrompt: "upstream prompt must be suppressed" }));
  };
}

function getTool(pi, name) {
  return pi.tools.find((tool) => tool.name === name);
}

test("drops the delegate-only /acp-subagents command and keeps the rest", () => {
  const pi = createPi();
  createLeanAcpExtension(fakeUpstream())(pi);
  // delegate 专属命令被拦截，不进入宿主
  assert.equal(pi.commands.has("acp-subagents"), false);
  // 通用 ACP 命令原样保留
  assert.equal(pi.commands.has("acp"), true);
  assert.equal(pi.commands.has("acp-status"), true);
});

test("strips dead delegate usage lines from acp_status output", async () => {
  const calls = [];
  const pi = createPi();
  createLeanAcpExtension(fakeUpstream(calls))(pi);
  const result = await getTool(pi, "acp_context").execute(
    "status-1",
    { op: "acp_status", args: {} },
  );
  const text = result.content.map((part) => part.text).join("\n");
  // 三种 delegate 噪音行全部消失
  assert.ok(!/Delegate usage:/.test(text), `still contains "Delegate usage:" line:\n${text}`);
  assert.ok(!/merged mode:/.test(text));
  assert.ok(!/Session delegate usage/.test(text));
  // 有用的概览内容不受影响，且行尾被修剪干净
  assert.ok(text.includes("CONTEXT OVERVIEW"));
  assert.ok(text.includes("Nudge: idle"));
  assert.ok(!/\s$/.test(text), "trailing whitespace should be trimmed");
  // 请求已转发给上游
  assert.equal(calls[0][0], "acp_status");
});

test("delegate tools stay suppressed alongside the new command filter", () => {
  const pi = createPi();
  createLeanAcpExtension(fakeUpstream())(pi);
  const names = pi.tools.map((tool) => tool.name);
  assert.deepEqual(names, ["compress", "acp_context"]);
});

test("real upstream registers no acp-subagents command through the facade", () => {
  // 用真实上游（default 导出，delegate:false + autoUpdate:false）注册一遍，
  // 验证拦截对上游真实的命令名与注册路径生效。
  const pi = createPi();
  (extensionModule.default ?? extensionModule)(pi);
  assert.equal(pi.commands.has("acp-subagents"), false);
  assert.equal(pi.commands.has("acp"), true);
  assert.equal(pi.commands.has("acp-status"), true);
});
