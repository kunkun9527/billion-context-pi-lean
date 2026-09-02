# billion-context-pi-lean-Notsub

[简体中文](README.zh-CN.md)

A lightweight Pi wrapper for [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi). It retains the upstream context compression engine while eliminating persistent system prompt bloat and redundant tool schemas.

## Core Features

* Full compression engine: Keeps upstream context compression, hierarchical summaries, nudges, overflow recovery, retry handling, and tool protection.
* Streamlined tool surface: Exposes the high-frequency `compress` tool directly, while consolidating `decompress`, `search_context`, and `acp_status` into an on-demand `acp_context` interface.
* Focused and clean: Removes the built-in subagent (delegation) feature — the `acp_delegate*` tools, the `/acp-subagents` command, and delegate usage noise — along with auto-updates, by design. For delegation workflows, pair with a dedicated subagent extension.

Upstream dependency is pinned to `billion-context-pi@0.1.52` for reliable behavior.

## Context Savings

In a local comparison against `billion-context-pi@0.1.52` with delegation disabled, persistent ACP prompt and tool metadata dropped from roughly 22,645 characters to 2,859 characters, achieving an approximate 87% reduction in static text overhead. Actual token savings may vary based on model tokenizer and prompt caching behavior.

## Installation

```bash
pi install git:github.com/miko-mepro/billion-context-pi-lean-Notsub
```

Or install from a local clone:

```bash
git clone https://github.com/miko-mepro/billion-context-pi-lean-Notsub.git
cd billion-context-pi-lean-Notsub
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

With only this extension enabled, its recurring initialization overhead in the model context is:

| Item | Lean | Upstream `billion-context-pi@0.1.52` |
| --- | ---: | ---: |
| `compress` | 216 | 549 |
| Context operations | `acp_context`: 90 | `decompress` + `search_context` + `acp_status`: 1,095 |
| System prompt additions | 369 | 4,417 |
| **Total** | **675** | **6,061** |

This saves **5,386 tokens (88.9%)** compared to the pinned upstream package.

The benchmark was measured on Pi 0.84.4 with `pi-context-view@0.4.3` in a fresh isolated session, excluding built-in tools, skills, context files, and unrelated extensions. Context View estimates tokens as `ceil(characters / 4)`. Pure runtime UI elements and slash commands are excluded as they are not sent to the model.

## Development

```bash
npm ci
npm run check
```

## License

MIT. This wrapper builds on the MIT-licensed [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi).