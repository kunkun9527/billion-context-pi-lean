# billion-context-pi-lean

[简体中文](README.zh-CN.md)

A token-lean Pi wrapper around [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi). It keeps the upstream context engine while reducing persistent system-prompt and tool-schema overhead.

## What it keeps

- Context compression, hierarchical summaries, nudges, overflow recovery, retry handling, and tool protection from upstream.
- The high-frequency `compress` tool as a direct model-facing tool.
- `decompress`, `search_context`, and `acp_status` through one on-demand `acp_context` facade.
- Concise ACP instructions that retain the rules needed for safe compression and recovery.

Built-in ACP delegation and automatic updates are intentionally disabled. Use a dedicated subagent extension if you need delegation. The upstream dependency is pinned to `billion-context-pi@0.1.52` for predictable behavior.

## Why it is lean

In a local comparison against `billion-context-pi@0.1.52` with delegation disabled, fixed ACP prompt and tool metadata decreased from about 22,645 characters to about 2,859 characters—roughly 87% less persistent text. Actual token and cost savings depend on the model tokenizer, provider, and prompt caching.

## Install

```bash
pi install git:github.com/kunkun9527/billion-context-pi-lean
```

Or install from a local clone:

```bash
git clone https://github.com/kunkun9527/billion-context-pi-lean.git
cd billion-context-pi-lean
npm install
pi install ./
```

Do not load this wrapper together with another `billion-context-pi` extension entry, or the ACP tools and hooks may be registered twice.

## Use

Model-facing tools:

```text
compress
acp_context
```

`acp_context` supports `decompress`, `search_context`, `acp_status`, and `help`.

```json
{
  "op": "search_context",
  "args": {
    "query": "authentication"
  }
}
```

Use `help` to request an upstream operation schema only when needed.

## Development

```bash
npm ci
npm run check
```

## License and upstream

MIT. This wrapper builds on the MIT-licensed [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi).