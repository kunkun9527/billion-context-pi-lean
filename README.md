# billion-context-pi-lean

[中文](#中文) · [English](#english)

## 中文

`billion-context-pi-lean` 是 [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi) 的轻量 Pi 包装层。它复用上游 `0.1.52` 的核心上下文引擎，同时减少长期注入模型的提示词和工具 schema。

### 特点

- 保留上游的上下文压缩、分层摘要、nudge、溢出恢复、限流重试和工具保护。
- 直接保留高频 `compress` 工具。
- 将低频的 `decompress`、`search_context`、`acp_status` 收拢为一个 `acp_context` 工具。
- 使用精简但保留关键安全规则的 ACP 系统提示。
- 固定依赖 `billion-context-pi@0.1.52`，避免上游升级意外改变包装层行为。
- 有意关闭上游内置 delegate 和自动更新；可以搭配独立的 subagent 扩展使用。

以 `billion-context-pi@0.1.52` 且同样关闭 delegate 的本地测量为例，固定 ACP 提示和工具元数据从约 22,645 字符降至约 2,859 字符，减少约 87%。实际 token 和费用收益取决于模型 tokenizer、供应商和提示缓存。

### 安装

```bash
pi install git:github.com/kunkun9527/billion-context-pi-lean
```

也可以本地安装：

```bash
git clone https://github.com/kunkun9527/billion-context-pi-lean.git
cd billion-context-pi-lean
npm install
pi install ./
```

### 模型可见工具

```text
compress
acp_context
```

`acp_context` 支持：

- `decompress`
- `search_context`
- `acp_status`
- `help`

示例：

```json
{
  "op": "search_context",
  "args": {
    "query": "authentication"
  }
}
```

### 开发

```bash
npm ci
npm run check
```

## English

`billion-context-pi-lean` is a token-lean Pi wrapper around [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi). It keeps the upstream `0.1.52` core context engine while reducing persistent prompt and tool-schema overhead.

It exposes `compress` directly and routes the lower-frequency `decompress`, `search_context`, and `acp_status` operations through `acp_context`. Built-in ACP delegation and automatic updates are intentionally disabled; the upstream dependency is pinned for predictable behavior.

Install:

```bash
pi install git:github.com/kunkun9527/billion-context-pi-lean
```

Validate locally:

```bash
npm ci
npm run check
```

## License

MIT. This project builds on the MIT-licensed [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi).
