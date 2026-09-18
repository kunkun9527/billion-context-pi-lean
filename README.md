# billion-context-pi-lean

[简体中文](README.zh-CN.md)

> **No longer updated.** Upstream adopted this wrapper's trimmed
> prompts (≈90% kept) as the built-in `lean` prompt pack
> ([issue #4](https://github.com/kunkun9527/billion-context-pi-lean/issues/4)).
> Just use the latest upstream with `{ "compress": { "promptPack": "lean" } }`
> in `acp.json`. Frontier-model users who want even leaner output can override
> sections in the same file, e.g. `promptSections` / `prompts` (see upstream
> CONFIGURATION). This wrapper stays as-is for reference.

A lightweight Pi wrapper for [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi). It retains the upstream context compression engine while eliminating persistent system prompt bloat and redundant tool schemas.

## Core Features

* Full compression engine: Keeps upstream context compression, hierarchical summaries, nudges, overflow recovery, retry handling, and tool protection.
* Streamlined tool surface: Exposes the high-frequency `compress` tool directly, while consolidating `decompress`, `search_context`, and `acp_status` into an on-demand `acp_context` interface.
* Focused and clean: Disables built-in delegation and auto-updates by design. For delegation workflows, pair with a dedicated subagent extension.

Upstream dependency is pinned to `billion-context-pi@0.1.69`; delegation remains disabled in this lean wrapper.

## Context Savings

<!-- token-benchmark:summary:start -->
> **Token benchmark: Lean 690, upstream `billion-context-pi@0.1.69` 5,802 — 88.1% fewer.**
<!-- token-benchmark:summary:end -->

## Installation

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

Do not load this wrapper alongside another `billion-context-pi` extension to prevent registering duplicate tools or hooks.

## Usage

The model interacts with two tools:

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

Use `help` only when you need to inspect the full upstream schema.

## Context Footprint Benchmark

<!-- token-benchmark:benchmark:start -->
With only this extension enabled, its recurring model-facing initialization contribution is:

| Variant | Tool and prompt contribution | Total |
| --- | --- | ---: |
| Lean `billion-context-pi-lean@0.1.69-lean.1` | `compress` (231) + `acp_context` (90) + prompt additions (369) | **690** |
| Upstream `billion-context-pi@0.1.69` | `compress` (549) + `decompress` (546) + `search_context` (210) + `acp_status` (339) + prompt additions (4,158) | **5,802** |

This saves **5,112 tokens (88.1%)**.
Measured with Pi 0.85.1 in separate temporary processes with empty working directories and configuration. Built-in tools, skills, context files, session history, user messages, unrelated extensions, runtime UI, and slash commands are excluded; `before_agent_start` additions are included. Tokens are a fixed character-proxy estimate using `ceil(characters / 4)`, not provider tokenizer billing.
<!-- token-benchmark:benchmark:end -->

## Development

```bash
npm ci
npm run check
```

## License

MIT. This wrapper builds on the MIT-licensed [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi).