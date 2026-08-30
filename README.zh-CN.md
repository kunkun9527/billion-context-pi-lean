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

## 开发

```bash
npm ci
npm run check
```

## 许可证与上游

MIT。本包装层基于采用 MIT 许可证的 [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi)。