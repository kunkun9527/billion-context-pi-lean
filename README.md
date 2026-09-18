# billion-context-pi-lean-Notsub

[简体中文](README.zh-CN.md)

A lightweight Pi wrapper for [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi). It retains the upstream context compression engine while eliminating persistent system prompt bloat and redundant tool schemas.

## Core Features

* Full compression engine: Keeps upstream context compression, hierarchical summaries, nudges, overflow recovery, retry handling, and tool protection.
* Streamlined tool surface: Exposes the high-frequency `compress` tool directly, while consolidating `decompress`, `search_context`, and `acp_status` into an on-demand `acp_context` interface.
* Dedicated compression model pool: `/acp-models` configures a ranked pool of summary models. `compress` only needs to pick consumed history ranges; the pool writes each summary from the real history, falls back through the queue, and finally to the current main model when needed.
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

### Compression Model Pool (`/acp-models`)

Run `/acp-models` in interactive Pi to configure summary models:

* The panel is a single bordered view with a title, a status bar (available / enabled / unsaved / kept-unavailable counts), a fixed search bar, sectioned list, feedback line, and key hints that wrap to the terminal width. The list is capped at 12 rows and shrinks with the terminal; titles, hints, and feedback are kept first, and a very small terminal only shows a short resize hint while `Esc` still exits.
* Only models that are both present in the registry and have configured auth are listed, as `model [provider]`. Models that were saved but are currently unavailable (missing from the registry, no auth, or a failing auth check) are hidden from the list instead of being marked — they are never selectable, but they are preserved in the config and re-appear at their saved rank once they become available again. The status bar reports how many such entries are kept.
* Keys: `space` selects the current row for reordering (press again to deselect; a model outside the pool first asks you to enable it), `up`/`down` browse or reorder inside the pool (never across the section boundary, and the cursor follows the model you moved), `enter` enables or disables, typed characters search model names and providers (reordering is disabled while searching, and typing leaves reorder mode), `Backspace`/`Ctrl+U` edit or clear the search, `Ctrl+S` saves, `Esc` discards. Enabled models always stay on top, and a newly enabled model is appended to the end of the queue.
* Saving runs inside the panel: `Ctrl+S` shows `saving…`, ignores all keys until the atomic replace finishes, and closes only after the write succeeded. A failed write keeps you in the panel with your search, cursor, and draft intact so you can retry or press `Esc`.
* The config lives in `compress-models.json` inside Pi's agent config directory (override with `PI_CODING_AGENT_DIR`) and stores only `{ provider, modelId }` — never credentials. Saving uses a temp file plus atomic replace, and a corrupt config is reported and never overwritten. The file always keeps the enabled queue first, followed by the kept-but-unavailable entries in their original order.

When `compress` runs:

* `summary` is now optional; if provided it is only a draft hint, and the pool always generates the final summary from the real history.
* The pool is tried in rank order; if every candidate is unavailable or fails, the main model from the start of the call is used as the last fallback. An empty pool goes straight to the main model.
* Each candidate request times out after 120 seconds by default. User cancellation stops immediately and is not treated as a model failure; insufficient context capacity, empty output, and over-length summaries all fall through to the next candidate.
* Every range must succeed before a single compression is committed — failures or cancellation never leave a partial compression behind. The model pool label appears only in the tool UI, and summary text, source copies, and fallback logs are not duplicated into model context.

## Context Footprint Benchmark

With only this extension enabled, its recurring initialization overhead in the model context is:

| Item | Lean | Upstream `billion-context-pi@0.1.52` |
| --- | ---: | ---: |
| `compress` | 238 | 549 |
| Context operations | `acp_context`: 111 | `decompress` + `search_context` + `acp_status`: 1,095 |
| System prompt additions | 424 | 4,417 |
| **Total** | **773** | **6,061** |

This saves **5,288 tokens (87.2%)** compared to the pinned upstream package.

The benchmark was measured on Pi 0.84.4 with `pi-context-view@0.4.3` in a fresh isolated session, excluding built-in tools, skills, context files, and unrelated extensions. Context View estimates tokens as `ceil(characters / 4)`. Pure runtime UI elements and slash commands are excluded as they are not sent to the model.

## Development

```bash
npm ci
npm run check
```

## License

MIT. This wrapper builds on the MIT-licensed [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi).