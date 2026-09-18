# billion-context-pi-lean

[English](README.md)

> **不再更新。** 上游已采纳本包装的精简提示词（保留约 90%），做成
> 内置 `lean` 提示词包
> （见 [issue #4](https://github.com/kunkun9527/billion-context-pi-lean/issues/4)）。
> 直接用最新上游，在 `acp.json` 里写 `{ "compress": { "promptPack": "lean" } }`
> 即可。用前沿模型还想再压的话，在同一个文件里覆盖对应段即可，如
> `promptSections` / `prompts`（见上游 CONFIGURATION）。本包装保持原样，仅供参考。

基于 [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi) 的精简封装。在完整保留上下文压缩引擎的同时，大幅剔除系统提示词与工具 Schema 中的冗余文本，显著降低上下文初始开销。

## 核心特性

* 完整上下文引擎：保留上游的对话历史压缩、分层摘要、主动提示（Nudge）、溢出恢复、重试机制与工具保护能力。
* 优化工具布局：高频使用的 `compress` 工具直接对外暴露，其余 `decompress`、`search_context` 与 `acp_status` 操作整合为按需调用的 `acp_context` 入口。
* 纯粹专注：主动移除了内置的 Delegation 代理分发与自动更新逻辑；如需多 Agent 协作，建议搭配独立的 Subagent 扩展使用。上游依赖版本锁定为 `billion-context-pi@0.1.69`，确保运行稳定可靠。

## 精简优化成效

<!-- token-benchmark:summary:start -->
> **Token 基准：Lean 690，上游 `billion-context-pi@0.1.69` 5,802，减少 88.1%。**
<!-- token-benchmark:summary:end -->

## 安装

```bash
pi install git:github.com/kunkun9527/billion-context-pi-lean
```

也可以通过本地克隆进行安装：

```bash
git clone https://github.com/kunkun9527/billion-context-pi-lean.git
cd billion-context-pi-lean
npm install
pi install ./
```

请勿与其它 `billion-context-pi` 扩展同时加载，以防重复注册 ACP 工具与生命周期 Hooks。

## 使用方法

模型可见工具包括：

```text
compress
acp_context
```

`acp_context` 支持 `decompress`、`search_context`、`acp_status` 和 `help`。

```json
{
  "op": "search_context",
  "args": {
    "query": "authentication"
  }
}
```

仅在确需查看完整上游 Schema 时调用 `help`。

## 初始化上下文占用对比

<!-- token-benchmark:benchmark:start -->
单独启用本扩展时，模型可见的常驻初始化上下文如下：

| 版本 | 工具与 Prompt 构成 | 合计 |
| --- | --- | ---: |
| Lean `billion-context-pi-lean@0.1.69-lean.1` | `compress` (231) + `acp_context` (90) + Prompt 注入 (369) | **690** |
| 上游 `billion-context-pi@0.1.69` | `compress` (549) + `decompress` (546) + `search_context` (210) + `acp_status` (339) + Prompt 注入 (4,158) | **5,802** |

节省 **5,112 tokens（88.1%）**。
测量环境为 Pi 0.85.1 的独立临时进程、空白工作目录与空白配置。排除内置工具、Skills、上下文文件、会话历史、用户消息、无关扩展、运行时 UI 与 Slash Commands；计入扩展的 `before_agent_start` 注入。Token 是按 `ceil(字符数 / 4)` 计算的固定字符代理估算，并非模型 tokenizer 实际计费值。
<!-- token-benchmark:benchmark:end -->

## 本地开发

```bash
npm ci
npm run check
```

## 开源协议与致谢

MIT 协议。本包装层基于采用 MIT 协议的 [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi)。