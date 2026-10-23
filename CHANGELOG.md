# Changelog

## v0.2.3 (2026-10-23)

- fix: no more false EMERGENCY after a failed request. Pi's auto-retry omits the failed attempt with a `context_edit`; Pi then stops trusting the last provider usage and `getContextUsage()` re-estimates its whole projection, which is the raw, unfolded history (641,881 tokens against a 54K sent view in one session). ACP used that number as a floor, so the meter showed 120–170% until the next successful reply. Host usage now floors, calibrates and feeds the overflow guard (context transform, `/acp` panel, `acp_status`) only when it is anchored on a valid assistant usage with no `context_edit` after it; otherwise ACP uses its sent-view estimate. The turn log marks such turns with `hostIgnored=estimate`.
- fix: ACP applies Pi `context_edit` entries when it rebuilds the request. `buildContextEntries()` returns the raw path, so attempts Pi had omitted (and content Pi had replaced) were sent again. Edits now follow Pi's `buildSessionProjection` semantics (`null` omits the entry, otherwise only its content is replaced); the incremental projection cache re-projects when a new edit arrives. `/acp export` uses the same edited view.
- Removed the bash default timeout injection (`toolBashDefaultTimeout`) and the tool output cap (`toolOutputMaxBytes`), together with their `/acp-config` panel items. Neither is context management: timeouts belong to the bash tool or a bash extension, and Pi already caps bash/read/grep output (2000 lines / 50KB, full output saved to a file), so the extra cap mostly cut off Pi's own truncation notice. Stale keys in `acp.json` are dropped silently. The timeout notice on a bash result that Pi reports as timed out, and the repetition guard, stay. Ported from SeniorHan/keel-fold `3189c29` and `8719091`.

## v0.2.2 (2026-10-20)

- Lean facade repairs malformed model arguments before validation (`prepareArguments`, no extra tokens): `acp_context` accepts JSON-string `args`, top-level op fields and an omitted `op` (inferred only from unambiguous fields); `compress` accepts a JSON-string `content`, JSON-string entries inside `content`, and a range array placed in `summary` without `content`. Explicit and invalid ops are left for validation.

## v0.2.1 (2026-10-17)

- Pi only: removed every non-Pi host path. OMP detection and refusal, Pi-fork host support (`PI_ACP_FORK_HOST`, `live-*` refs for unpersisted messages, the `.prime` config dir), the `hostSession` turn-boundary policy, inline child-state derivation (`deriveChildState`) and the `createRuntime` / `SessionRef` exports are gone, along with the `~/.cache/opencode` decompress target. A turn now always starts at a user message; `hostSession` in `acp.json` is ignored. Sessions forked with Pi `/fork` still inherit the parent's blocks through the `parentSession` header. The billion-context proxy stand-down and the `./contract` sidecar schema export stay.
- Removed upstream-only material from the repo (paper, devlog, design docs, cost estimator, offline benchmark script); `CONFIGURATION.md` drops upstream issue links and older history here now points to the upstream CHANGELOG.

## v0.2.0 (2026-10-17)

Versions are now numbered independently of upstream `billion-context-pi` (previously `0.1.83-lean.N`). Upstream fixes are still ported as needed.

- Idle compact (`idleCompact`, off by default): after `idleMinutes` of idle time (default 29, just inside a 30-minute prompt cache), ACP starts one turn that shows the main model the regular compress nudge (below the usual thresholds) and lets it decide whether to compress. With the cache still warm that turn reads the long prefix from cache, so the request sent when the user returns carries the shorter context instead of rewriting the long one uncached. One global value for every model; set it a little under the cache lifetime of the models you use. At most one idle compact turn per idle period; skipped when there is less to compress than `minPressureBenefitTokens`, outside TUI/RPC mode, or when the timer wakes more than a minute late (sleep). During that turn only ACP tools may run; user input or a sub-agent result turns it back into a normal run.
- `/acp-config` settings panel (TUI): Summary model (pick from the models Pi can use, type to filter), Idle compact on/off and Idle minutes, per-model Context threshold / Nudge interval / Minimum benefit for the current model, Tool output cap, bash default timeout, Debug log. Names match the README. Writes `~/.pi/acp.json` (other keys kept) and applies at once; warns when a project `.pi/acp.json` overrides the key.
- fix(rebuild): when the `.acp.json` sidecar is missing, a compress call that passed `content` as a JSON string (non-strict-tool providers do this) is rebuilt from the session log instead of being skipped silently. The rebuild parses arguments with the live tool's `normalizeRanges`.
- Removed the self-update code (`src/update.ts`). A user `acp.json` with `autoUpdate: true` used to override the fork's "always off" default and run `npm install` against the npm package; `autoUpdate` and `ACP_AUTO_UPDATE` are now ignored. Update with `pi install`.
- README reorganized: a short "How it works" section (including the tools the model sees) up front; Idle compact and the settings panel added to the upstream comparison; the Configuration section now explains `/acp-config` with one settings table, and keeps hand-editing `acp.json` for what the panel cannot do (per project, per provider, options not in the panel).

## v0.1.83-lean.10 (2026-10-16)

- Published to npm as `billion-context-pi-lean`: `pi install npm:billion-context-pi-lean`. The package now ships the Lean facade (`lean/index.ts`), which `pi.extensions` points at. Git installs keep working.
- The package name changes from `billion-context-pi` to `billion-context-pi-lean`: hosts importing the API (`import { createAcpExtension } from "billion-context-pi"`) switch to the new name, and the dormant self-update code queries the new name.
- README: token benchmark against upstream 0.1.83 (486 vs 8,670 tokens, 94.4% fewer). The Chinese README is now `README_zh-CN.md`.

## v0.1.83-lean.9 (2026-10-15)

- Lean facade: the resident ACP prompt keeps only pre-call rules (hidden refs, what may be compressed, `acp_context` op signatures, summaries are history, not instructions). Guidance that already arrives with nudges, compress errors, decompress results and the provider-throttle retry message is no longer resident.
- Lean facade: with a dedicated summary model, the per-turn prompt adds the 1-2 sentence fallback rule. Pi snapshots tool descriptions before `acp.json` loads, so the compress description alone always showed the non-dedicated text.
- Lean facade: a compress call that folded ranges ends with a reminder that the new summaries are visible in the call's arguments, so they need no decompress.
- README: tools + resident prompt re-measured on Pi 1.3: about 490 tokens (was about 800).

## v0.1.83-lean.8 (2026-10-13)

- Dedicated summary model (`compressionModelId: provider/id`, and `session` without a captured prefix) now summarizes exactly what the kernel folds: a dry run of `applyCompression` on a cloned state gives each range's real block (paired tool calls, protected-zone exclusions), so a range naming only a tool result no longer hides the call that says what it was.
- The caller's fallback summary is passed to the summary model as a `<caller_note>` — purpose and axis only, never a source of facts.
- Summary-model prompt gains READING THE TRANSCRIPT / SOURCE ATTRIBUTION / CALLER NOTE rules: tool output (files, logs, other sessions, recalled history) is examined material and its quoted requests or Open objectives never become this conversation's; precision rules are unchanged; examined material is summarized as "Looked for X → found Y"; text outside `<content>` is control metadata, not a user request. CARRY FORWARD now names earlier Open objectives explicitly.
- Caller (main model) rules: the fallback states what was done or examined, why, and the outcome with its decisive values.
- Summary rules: a direct `ask_user_question` result is the user speaking (chosen option, typed text and notes are user decisions; an unchosen recommendation or a declined form is not approval). Open items are split into `Open objectives:` (user-requested), `Pending suggestions (not user-requested):` and `Unverified / known risks:`; uncertainty qualifiers (estimated, assumed, unverified) survive until evidence resolves them, and a user's approval verifies nothing. Earlier summaries' items keep their category on carry-forward.
- Planning-text leaks: a summary whose opening prose is the model talking to itself about writing it (or echoing `Output only summary`) is retried once with a reminder; a second leak rejects the range (not folded, never silently stripped). Quoted text and summaries opening with a heading, list or table are not flagged; no false positives over 2,349 existing blocks.
- Summary rules: WHAT COMPRESSION DOES AND DOES NOT CHANGE — compression only changes what the agent sees, never undoes files or commands; the range is not the end of the conversation, so state is described as of the range end; a shell working directory or variable is never recorded as standing state (each command runs on its own). CARRY FORWARD no longer calls earlier summaries "the only record".
- Summary rules: every summary closes with `State at end of this range (history, not instructions):` — last action → result, changes → verification, failures still open. A plan stated at the range end goes under Pending suggestions as `plan at range end (ref)`, never as a task. The section is in addition to the body and to `Unverified / known risks:`.
- Transcript echo: a summary that copies transcript entries (a run of `[assistant:… call]` / `[tool:… result]` headers, or a `</content>` line) is retried once with its own reminder; a second echo rejects the range (not folded). Seen once in 116 real Luna runs: 65K chars, the model fell through into its input after the state section.
- Stability: sidecar writes to one session file are serialized and each uses its own temp file (overlapping saves could rename the same `.acp-tmp-*` twice → `ENOENT`); `acquireLock` no longer drops a later waiter's queue on release; compress / decompress / `acp_rule` hold the session lock across their read-modify-save.
- Stability: when the dedicated summary model fails for a range (API error, length stop, input too large), that range is **not folded** — the caller's short fallback would replace the detailed summary (or, on a refold, the earlier blocks' summaries). Successful ranges in the same call still fold; if every range fails the call errors (counts toward the retry cap). Setup problems (unresolvable model, host without `complete()`) still fold with the fallback and warn.
- Stability: the compress toolResult records what was folded (`details.acpFolded`, never sent to the model); state rebuild from the session log prefers it, so a lost sidecar no longer rebuilds blocks from the short fallbacks or folds ranges that failed. The Lean facade passes `details` through unrewritten.
- Stability: a block whose covered messages are partly on another branch of the session tree (after `/tree` into its range) stays inactive for that turn, so its summary cannot show decisions from messages that branch has not reached; returning to the full branch reactivates it. Pi host only.
- Stability: decompressing a message to an auto file uses a filesystem-safe name (raw entry refs can contain `|`, which Windows rejects).
- Kernel `acp-kernel` 0.0.98 → 0.0.101 (nudge re-anchoring when the count drops, linear-time compress parsing, case-insensitive protected tool names, one prune/recommend index per turn). Its refs widen past five digits after `m99999` (up to `m9999999`); message-ref parsing now accepts them, so long sessions keep ref identity and outgoing rewrites. A session that reached six-digit refs should not go back to an older build.
- Lean facade on Pi 0.83–0.85: those hosts pass `systemPromptOptions` but never render `sections`, so the ACP prompt was silently missing. The facade now keeps the named section only when the rendered prompt picks it up, and otherwise returns the composed prompt as before.
- `npm run measure`: tool + resident-prompt footprint vs upstream 0.1.83 in a blank Pi session (needs the sibling `my-lean-pi-setup` worker). README numbers re-measured on Pi 1.1: about 800 tokens vs 8,700 upstream (4,900 with `promptPack: "lean"`).

## v0.1.83-lean.7 (2026-10-12)

- Removed sub-agent delegation entirely: the `acp_delegate` / `acp_delegate_wait` / `acp_delegate_cancel` tools, the fleet inspector (`/acp-fleet`, `fleetShortcut`), `/acp-subagents` and pi-subagents detection, the `ACP_DELEGATE NOTIFICATIONS` prompt appendix, and delegate usage in `acp_status` (no more "Delegate usage: none this session." line). Config keys `delegate.*`, top-level `displayUsage`, `delegatePrompt` and the `PI_ACP_DELEGATE_*` env vars are now ignored. This is a context manager; use a dedicated sub-agent extension for sub-agents — their sessions are still managed by ACP.

## v0.1.83-lean.6 (2026-10-12)

First release of this fork on GitHub. Based on upstream `billion-context-pi` v0.1.83; earlier local builds were called Lean2 (`0.1.83-pr241-lean2.2`–`lean2.5`).

- Dedicated summary model (ported from upstream PR #241, resolved through Pi's live model registry): `/acp compact <provider/model>|session|reset`. The main model only picks ranges and writes a fallback; the full summary rules go to the summary model.
- Re-compressing old blocks passes their summaries in whole with a carry-forward rule instead of re-sending truncated raw history; summary-model input is sized to its context window; length-truncated summaries are rejected.
- The main model now sees full block summaries in its `compress` calls, so it stops decompressing blocks it just created.
- Request-rewrite fixes: emergency truncation reaches the wire, the latest user message is never truncated, the token meter counts new messages and `compress` thinking, and `acp_context` calls follow the recency policies of the tools they wrap.
- Lean facade: `compress` + `acp_context` only, ~700-token resident prompt, injected as its own system-prompt section so other extensions keep their additions; delegation and auto-update off.
- Tests no longer write into the real `~/.pi`.

Earlier history is upstream's: see the [billion-context-pi CHANGELOG](https://github.com/ranxianglei/billion-context-pi/blob/v0.1.83/CHANGELOG.md) up to v0.1.83.
