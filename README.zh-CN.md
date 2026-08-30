# billion-context-pi-lean

[English](README.md)

[`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi) 的 token 精简版 Pi 包装层。它保留上游上下文引擎，同时减少长期存在的系统提示词和工具 schema 开销。

## 保留的能力

- 上游的上下文压缩、分层摘要、nudge、溢出恢复、重试处理和工具保护。
- 将高频 `compress` 作为直接面向模型的工具。
- 通过一个按需使用的 `acp_context` facade 提供 `decompress`、`search_context` 和 `acp_status`。
- 精简 ACP 指令，同时保留安全压缩和恢复所需的规则。

上游内置的 ACP delegation 和自动更新被有意关闭。需要 delegation 时请搭配独立的 subagent 扩展。上游依赖固定为 `billion-context-pi@0.1.52`，以保证行为可预测。

## 为什么更精简

在关闭 delegation 的情况下，与 `billion-context-pi@0.1.52` 进行本地对比，固定 ACP 提示词和工具元数据从约 22,645 个字符降至约 2,859 个字符，长期文本约减少 87%。实际 token 和费用收益取决于模型 tokenizer、供应商和提示缓存。

## 安装

```bash
pi install git:github.com/kunkun9527/billion-context-pi-lean
```

也可以从本地 clone 安装：

```bash
git clone https://github.com/kunkun9527/billion-context-pi-lean.git
cd billion-context-pi-lean
npm install
pi install ./
```

不要同时加载本包装层和另一个 `billion-context-pi` 扩展入口，否则 ACP 工具和 hooks 可能被重复注册。

## 使用

模型可见工具：

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

仅在需要时使用 `help` 获取上游操作 schema。

## 实测初始化上下文占用

仅启用本扩展时，lean 包装层会贡献约 **675 tokens** 的持续模型可见初始化上下文：

| 项目 | Lean | 上游 `billion-context-pi@0.1.52` |
| --- | ---: | ---: |
| `compress` | 216 | 549 |
| 上下文操作 | `acp_context`：90 | `decompress` + `search_context` + `acp_status`：1,095 |
| 系统提示词增量 | 369 | 4,417 |
| **合计** | **675** | **6,061** |

相比固定版本的上游扩展，减少 **5,386 tokens（88.9%）**。测量使用 Pi 0.84.4 和 `pi-context-view@0.4.3`，在全新隔离会话中只启用目标扩展，并排除 Pi 内置工具、skills、context files、消息及无关扩展。Context View 按 `ceil(字符数 / 4)` 估算，因此这些是可复现的上下文占用估值，不是 GPT tokenizer 的精确计数。未计入不会发送给模型的纯运行时 UI 和 slash commands。

## 开发

```bash
npm ci
npm run check
```

## 许可证与上游

MIT。本包装层基于采用 MIT 许可证的 [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi)。