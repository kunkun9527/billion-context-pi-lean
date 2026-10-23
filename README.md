# billion-context-pi-lean

<!-- token-benchmark:summary:start -->
> **Token benchmark: Lean 486, upstream `billion-context-pi@0.1.83` 8,670 — 94.4% fewer.**
<!-- token-benchmark:summary:end -->
> [See my full setup for Pi](https://github.com/kunkun9527/my-lean-pi-setup)

[中文](https://github.com/kunkun9527/billion-context-pi-lean/blob/main/README_zh-CN.md)

Context management for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) that lets long sessions keep going: as context fills up, the model folds finished work into summary blocks, and the originals stay recoverable on demand.

This is a fork of [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi) **v0.1.83** that focuses on runtime stability and on spending fewer tokens. It keeps upstream's compression engine (ACP); the main additions are that **a cheap model can write the summaries**, that **context management itself costs fewer tokens**, and that **a long session is compressed while you are away**, before the prompt cache expires. Upstream has moved on to [`billion-context`](https://github.com/ranxianglei/billion-context); this fork stays on 0.1.83 and picks upstream fixes by hand. It is not affiliated with upstream.

## How it works

ACP does not compress on its own. When old, finished work piles up, it adds a short **compress nudge** to the next request, listing the message ranges that could be folded. The main model picks ranges and calls `compress`; the **summary model** (the main model itself unless you choose another) writes the summaries, and each range is replaced by its summary block. The originals stay in the session and can be brought back.

The model sees two tools:

- `compress`: fold finished message ranges into summary blocks.
- `acp_context`: `decompress`, `search_context`, `acp_status`, `acp_cache` and `help`, e.g. `{ "op": "search_context", "args": { "query": "authentication" } }`, to bring originals back or look things up.

Malformed calls are repaired before validation instead of failing: JSON-string `args` or `content`, op fields written at the top level, an omitted `op` (inferred only from unambiguous fields such as `blockId`), and a range array put in `summary` instead of `content`.

With **Idle compact** on, the same nudge is also shown once when you step away, while the prompt cache is still warm, so you come back to a shorter context. When the [settings](#settings) make the nudge appear is up to you; as a last resort, at 95% of the window ACP cuts large tool outputs regardless.

## Main differences from upstream 0.1.83

| | Upstream 0.1.83 | This fork |
|---|---|---|
| Who writes summaries | The main model, usually the expensive one | A **dedicated summary model** of your choice, e.g. a cheap one; the main model only picks the ranges |
| Compression rules | Sent to the main model in every compression nudge (about 1,460 tokens; 720 with `promptPack: "lean"`) | Sent only to the summary model, so they no longer take up the main model's context; its nudge carries only a short range-picking note (about 220 tokens)\* |
| Summary quality | General compression rules; only length is checked | Also: user requests are kept apart from what tools showed; open items are split into user objectives, suggestions and unverified risks. A failed or malformed summary is not folded; the range waits for a later attempt |
| Coming back after a break | The first request rewrites the whole long context at uncached prices | **[Idle compact](#idle-compact)**: before the cache expires, the model gets one chance to compress, so the request you send on return is shorter |
| Settings | Edit `acp.json` by hand | **[`/acp-config`](#configuration) panel**: pick values in the TUI, applied at once without restarting; `acp.json` still works |
| Tools and resident prompt | 5 context tools + 3 delegation tools, about 8,700 tokens (4,900 with `promptPack: "lean"`) | `compress` + `acp_context`, 486 tokens ([benchmark](#context-footprint-benchmark)). The resident prompt keeps only rules needed before a call; the rest arrives with nudges, errors and tool results |
| System prompt | Returns a whole system prompt, which on Pi 1.x drops prompt additions from extensions loaded after it | Added as its own section; other extensions keep theirs |
| Sub-agent delegation, auto-update | Built in | Removed. Use a dedicated sub-agent extension; ACP still manages their sessions |
| bash default timeout, tool output cap | Built in (`toolBashDefaultTimeout`, `toolOutputMaxBytes`) | Removed: not context management. Pi already caps bash/read/grep output; leave timeouts to the bash tool or a bash extension |

\* Estimated as `ceil(chars / 4)` from the length of the rule text in the nudge, not billed tokens.

<details>
<summary>Smaller upstream issues fixed in this fork</summary>

- Emergency truncation was computed but never reached the request.
- Emergency truncation could cut the latest user message.
- The token meter reused an old count and ignored newly added messages.
- Reasoning inside `compress` calls was not counted.
- Concurrent state saves could fail (`ENOENT` on a shared temp file), and releasing the session lock could let a later caller jump the queue.
- After `/tree` into the middle of a block, its summary could show decisions from messages the current branch never reached.
- Decompressing to a file failed on Windows when the message ref contained `|`.
- The test suite wrote into the real `~/.pi`.
- After a failed request Pi re-estimates the raw, unfolded history; ACP took that as a floor and showed 120–170% with a false EMERGENCY nudge until the next successful reply.
- Pi `context_edit` entries were ignored, so attempts Pi had omitted after a failure were sent again.

Details: [CHANGELOG.md](CHANGELOG.md), [MAINTENANCE.md](MAINTENANCE.md) (Chinese).

</details>

## Context footprint benchmark

With only this extension enabled, its recurring model-facing initialization contribution is:

| Variant | Tool and prompt contribution | Total |
| --- | --- | ---: |
| Lean `billion-context-pi-lean@0.2.3` | `compress` (231) + `acp_context` (87) + prompt (168) | **486** |
| Upstream `billion-context-pi@0.1.83` with `promptPack: "lean"` | `compress` (389) + `decompress` (271) + `search_context` (90) + `acp_status` (227) + `acp_cache` (204) + `acp_delegate` (1,452) + `acp_delegate_wait` (342) + `acp_delegate_cancel` (83) + prompt (1,819) | **4,877** |
| Upstream `billion-context-pi@0.1.83` | `compress` (549) + `decompress` (546) + `search_context` (210) + `acp_status` (339) + `acp_cache` (204) + `acp_delegate` (1,452) + `acp_delegate_wait` (342) + `acp_delegate_cancel` (83) + prompt (4,945) | **8,670** |

This saves **8,184 tokens (94.4%)** against upstream's default, and 4,391 tokens (90.0%) against its `lean` prompt pack. The three `acp_delegate*` tools (1,877 tokens) belong to sub-agent delegation, which this fork removed; leaving them out, the savings are 92.8% and 83.8%.

Compression nudges come on top of this and only when context fills up. With a dedicated summary model, the rules in each nudge drop from about 1,460 tokens to about 220 ([setup](#settings)).

Measured with `npm run measure` on Pi 1.3.0, each variant in a separate temporary process with an empty working directory and configuration. Built-in tools, skills, context files, session history, user messages, unrelated extensions, runtime UI, and slash commands are excluded; `before_agent_start` additions are included. Tokens are a fixed character-proxy estimate using `ceil(characters / 4)`, not provider tokenizer billing.

## Install

```bash
pi install npm:billion-context-pi-lean
```

Append `@<version>` to pin a version from [Releases](https://github.com/kunkun9527/billion-context-pi-lean/releases). Installing from git works too: `pi install git:github.com/kunkun9527/billion-context-pi-lean`.

- The dedicated summary model needs Pi 1.x or later.
- Do not enable it together with `billion-context-pi` or `billion-context`: tools and hooks would register twice.
- Pi's built-in compaction is turned off while this extension is active.

## Configuration

Type `/acp-config` in Pi to open the settings panel. Up/Down picks a setting, Enter or Space changes it, Esc closes. Changes apply at once, no restart needed.

### Settings

The panel lists these, most used first.

| Setting | What it does | Default |
|---|---|---|
| Summary model | Who writes the summaries. `main model`: the main model writes them itself. `session`: the current model, in a separate call that reuses its cached prefix. Or pick any model Pi can use (Enter opens the list; type to filter), e.g. a cheap one. If that model's call fails, the range stays uncompressed and is tried again next time. | `main model` |
| Idle compact | Compress once while you are away, before the prompt cache expires ([how it works](#idle-compact)). | `off` |
| Idle minutes | How long the session must be idle first. Keep it a little under your models' cache lifetime: 29 fits a 30-minute cache. | 29 |
| Context threshold | Share of the model's window above which the compress nudge no longer waits for Nudge interval and appears whenever Minimum benefit could be reclaimed. Lower keeps the context small; higher lets it run fuller. Not a hard cap. | 75% |
| Nudge interval | Below Context threshold, the nudge waits until about this many tokens of old, compressible content have piled up. Bigger: fewer nudges, more folded at once. Smaller: frequent small compressions, a leaner context. | 50K |
| Minimum benefit | No nudge, and no idle compact, when less than this could be reclaimed: rewriting a few thousand tokens is not worth breaking the cache. | larger of 5K and 1% of the window |
| Debug log | Writes detailed events to `~/.pi/acp.log` for troubleshooting. Errors and the main events are always logged. | `off` |

Context threshold, Nudge interval and Minimum benefit depend on the model's window and price, so the panel sets them for the **current model only**; switch models to set another one. `inherit` drops the model's own value; a provider-wide or global value from `acp.json`, or else the default, applies.

Regardless of these settings, at 95% of the window ACP cuts large tool outputs as a last resort.

### Idle compact

Coming back to a long session after the prompt cache expired means the first request rewrites the whole context uncached. With Idle compact on, after Idle minutes without activity ACP starts one turn that shows the main model the compress nudge; the model decides whether to compress.

- Activity means a real model request: your messages, and also a sub-agent waking the session, so long background work does not count as idle.
- At most one such turn per idle period. Skipped when less than Minimum benefit could be reclaimed, outside the TUI and RPC modes, or when the timer fires more than a minute late (the machine slept).
- During that turn only ACP tools may run. If you type or a sub-agent result arrives, it becomes a normal turn.
- Idle minutes applies to every model. With a shorter cache (e.g. 5 minutes) that turn itself reads the long context uncached once.

### Editing acp.json

The panel saves to `~/.pi/acp.json` and keeps every other key there. Edit the file yourself only for what the panel cannot do:

- **Per project:** `<project>/.pi/acp.json` overrides the global file. The panel shows the value in effect and warns when the project file overrides it.
- **Per provider:** the three compression timing settings can also be set for a whole provider or globally, not only for one model ([how](CONFIGURATION.md#compressproviders--per-provider--per-model-overrides)).
- **Options not in the panel**, e.g. `compress.emergencyThresholdPercent`. The full list is in [CONFIGURATION.md](CONFIGURATION.md), with these exceptions: `autoUpdate` and `ACP_AUTO_UPDATE` are gone (update with `pi install`); the removed delegation keys (`delegate.*`, `displayUsage`, `delegatePrompt`) are ignored; `promptSections.*` is ignored with a one-time warning, because this fork injects its own prompt.

Panel settings map to these keys: Summary model `compressionModelId`, Idle compact `idleCompact.enabled`, Idle minutes `idleCompact.idleMinutes`, Debug log `debug`.

`/acp compact <provider/model>` sets the summary model from the command line (`/acp compact` shows it, `reset` returns to the main model).

## Development

```bash
npm ci
npm run check   # typecheck, tests, build and facade checks
npm run measure # tool + prompt footprint vs upstream (needs ../my-lean-pi-setup)
```

`dist/` is committed because Pi installs git packages without building them; commit it together with source changes. Maintenance notes: [MAINTENANCE.md](MAINTENANCE.md).

## License

MIT. Based on [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi) by ranxianglei and contributors (MIT), including the dedicated summary model from upstream PR #241.
