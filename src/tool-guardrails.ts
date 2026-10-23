import { createHash } from "node:crypto";
import {
  isBashToolResult,
  type ExtensionAPI,
  type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { resolveRepetitionGuard } from "./config.js";
import { debug, logInfo, logWarn } from "./log.js";
import type { AcpRuntime } from "./runtime.js";

type ContentPart = ToolResultEvent["content"][number];

const TIMEOUT_RE = /Command timed out after (\d+) seconds/;

export function detectBashTimeout(content: ToolResultEvent["content"]): number | undefined {
  for (const c of content) {
    if (c.type !== "text") continue;
    const m = (c as { text: string }).text.match(TIMEOUT_RE);
    if (m) return Number(m[1]);
  }
  return undefined;
}

function appendTrailingText(
  content: ToolResultEvent["content"],
  notice: string,
): ToolResultEvent["content"] {
  const next = [...content];
  for (let i = next.length - 1; i >= 0; i--) {
    const part = next[i];
    if (part && part.type === "text") {
      next[i] = { type: "text", text: (part as { text: string }).text + notice } as ContentPart;
      return next;
    }
  }
  next.push({ type: "text", text: notice } as ContentPart);
  return next;
}

export function appendTimeoutNotice(
  content: ToolResultEvent["content"],
  secs: number,
): ToolResultEvent["content"] {
  return appendTrailingText(content, buildTimeoutNotice(secs));
}

function buildTimeoutNotice(secs: number): string {
  const suggested = Math.min(Math.max(Math.ceil(secs * 2), 120), 3600);
  return `\n\n[ACP guardrail: command killed after ${secs}s. To give it more time, re-run the bash tool with a larger \`timeout\` argument (e.g. \`"timeout": ${suggested}\`).]`;
}

// --- Generic tool-call repetition guard (issue #308) ---
// Token-level penalties act on within-sequence tokens and cannot break a
// sequence-level attractor where a greedy small model re-emits the same
// (assistant -> toolResult) pair every turn. The only reliable signal is the
// byte-for-byte identity of consecutive tool calls. We track the length of the
// current consecutive run per session: at `warn` we append a strong warning to
// the matching toolResult; at `abort` we refuse the call (block + error
// toolResult) and abort the turn so the loop breaks. Any argument change
// (or a switch to another tool) resets the run.
export function canonicalStringify(value: unknown): string {
  if (value === null || value === undefined || typeof value !== "object") {
    try {
      return JSON.stringify(value) ?? "null";
    } catch {
      return String(value);
    }
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalStringify(v)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalStringify(v)}`).join(",")}}`;
}

export function repetitionFingerprint(toolName: string, input: unknown): string {
  const payload = `${toolName}\u0000${canonicalStringify(input ?? {})}`;
  try {
    return createHash("sha1").update(payload).digest("hex");
  } catch {
    return `unhashable:${toolName}`;
  }
}

export type RepetitionAction = "none" | "warn" | "abort";
export interface RepetitionDecision {
  action: RepetitionAction;
  count: number;
  fingerprint: string;
  toolName: string;
}

export class RepetitionTracker {
  private lastFp: string | null = null;
  private count = 0;
  constructor(private readonly thresholds: { warn: number; abort: number }) {}
  note(toolName: string, input: unknown): RepetitionDecision {
    const fp = repetitionFingerprint(toolName, input);
    if (fp === this.lastFp) this.count += 1;
    else {
      this.lastFp = fp;
      this.count = 1;
    }
    let action: RepetitionAction = "none";
    if (this.count >= this.thresholds.abort) action = "abort";
    else if (this.count >= this.thresholds.warn) action = "warn";
    return { action, count: this.count, fingerprint: fp, toolName };
  }
  reset(): void {
    this.lastFp = null;
    this.count = 0;
  }
}

function buildRepetitionWarnNotice(toolName: string, count: number): string {
  return `\n\n[ACP guardrail: you have issued ${count} CONSECUTIVE identical \`${toolName}\` calls (name + arguments byte-for-byte identical). Re-running the exact same call will not produce a new result. STOP issuing this identical call — change your approach, change the arguments, or stop and report to the user.]`;
}

function buildRepetitionAbortNotice(toolName: string, count: number): string {
  return `[ACP guardrail: BLOCKED — you issued ${count} consecutive identical \`${toolName}\` calls (byte-for-byte identical arguments). This call was refused and NOT executed. You MUST change strategy: use different arguments, a different tool, or stop and report to the user. Do not re-issue the identical call. The turn has been aborted.`;
}

export function wireToolGuardrails(pi: ExtensionAPI, runtime: AcpRuntime): void {
  const trackers = new Map<string, RepetitionTracker>();
  const pendingWarns = new Map<string, number>();

  pi.on("tool_call", (event, ctx) => {
    const cfg = resolveRepetitionGuard(runtime.adapter);
    if (!cfg.enabled) return;
    const sid = ctx.sessionManager.getSessionId();
    let tracker = trackers.get(sid);
    if (!tracker) {
      tracker = new RepetitionTracker(cfg);
      trackers.set(sid, tracker);
    }
    const decision = tracker.note(event.toolName, event.input);
    debug.event("guardrail-repetition", { sid, tool: decision.toolName, count: decision.count, action: decision.action });
    if (decision.action === "abort") {
      const msg = buildRepetitionAbortNotice(decision.toolName, decision.count);
      logWarn("guardrail", { event: "repetition-abort", sid, tool: decision.toolName, count: decision.count });
      if (ctx.hasUI) ctx.ui.notify(`[ACP] ${msg}`, "warning");
      try {
        ctx.abort();
      } catch {
        // mid-tool abort is best-effort; the block below guarantees the refusal
      }
      return { block: true, reason: msg };
    }
    if (decision.action === "warn") {
      logInfo("guardrail", { event: "repetition-warn", sid, tool: decision.toolName, count: decision.count });
      pendingWarns.set(event.toolCallId, decision.count);
    }
  });

  pi.on("tool_result", (event) => {
    const isBash = isBashToolResult(event);
    const timeoutSecs =
      isBash && event.isError ? detectBashTimeout(event.content) : undefined;

    let modified: ToolResultEvent["content"] | undefined;

    if (timeoutSecs !== undefined) {
      modified = appendTimeoutNotice(modified ?? event.content, timeoutSecs);
      debug.event("guardrail-bash-timeout-notice", { secs: timeoutSecs });
      logInfo("guardrail", { event: "bash-timeout-notice", secs: timeoutSecs });
    }

    const warnCount = pendingWarns.get(event.toolCallId);
    if (warnCount !== undefined) {
      pendingWarns.delete(event.toolCallId);
      modified = appendTrailingText(modified ?? event.content, buildRepetitionWarnNotice(event.toolName, warnCount));
      debug.event("guardrail-repetition-warn-injected", { tool: event.toolName, count: warnCount });
    }

    if (modified) return { content: modified };
  });

  pi.on("input", (event, ctx) => {
    if (event.source === "extension") return;
    trackers.get(ctx.sessionManager.getSessionId())?.reset();
  });
  pi.on("session_shutdown", (_e, ctx) => {
    trackers.delete(ctx.sessionManager.getSessionId());
  });
}
