import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { CompressionBlock, CoreMessage } from "acp-kernel";
import { inlineBlockSummaries } from "./compress-tool.js";
import { coreOutToAgentMessages } from "./messages.js";
import { countThinkingChars, dropCompressReasoning, type CompressReasoningConfig } from "./reasoning-drop.js";
import { collapseAssistantDegeneration, degenerationNotice, lastAssistantRuns, resolveDegenerationGuard, type DegenerationGuardConfig } from "./degeneration.js";
import { carryHostSystemMessages } from "./system-passthrough.js";
import { sanitizeToolPairing } from "./tool-pair-sanitizer.js";

type AgentMessage = SessionMessageEntry["message"];

/** Phase 1: rewrite persisted history only. No nudge or live-only host tail may
 * enter this phase: a synthetic user message would falsely close an in-flight
 * compress round (#348). Rebuilds never modify the persisted entry objects. */
export function prepareHistoryForSend({ messages, blocks, entries, reasoningDrop, degenerationGuard }: {
  messages: CoreMessage[];
  blocks: CompressionBlock[];
  entries: SessionEntry[];
  reasoningDrop: CompressReasoningConfig;
  degenerationGuard?: boolean | DegenerationGuardConfig;
}) {
  const originals = new Map<string, AgentMessage>();
  for (const entry of entries) {
    if (entry.type === "message") {
      originals.set(entry.id, entry.message);
    } else if (entry.type === "custom_message") {
      // Pi's convertToLlm projects custom messages as user messages. Restoring
      // role:"custom" instead would make Pi drop them from provider context.
      const content = typeof entry.content === "string"
        ? [{ type: "text" as const, text: entry.content }]
        : entry.content;
      originals.set(entry.id, { role: "user", content } as AgentMessage);
    }
  }
  // Lean drops acp_summary_ messages: their full text lives in the matching
  // compress-call arguments, replacing the kernel's 200-character stub.
  const rebuilt = inlineBlockSummaries(coreOutToAgentMessages(messages, originals), blocks);
  const withoutThinking = dropCompressReasoning(rebuilt, reasoningDrop);
  const droppedThinkingChars = withoutThinking === rebuilt ? 0 : countThinkingChars(rebuilt) - countThinkingChars(withoutThinking);
  const cfg = resolveDegenerationGuard(degenerationGuard);
  // Inspect originals: a thinking-only aborted tail is absent from CoreMessage
  // projection, but must still get a recovery notice (#351).
  const tailRuns = cfg.enabled ? lastAssistantRuns([...originals.values()], cfg.minRun) : null;
  const collapsed = collapseAssistantDegeneration(withoutThinking, cfg);
  const maxCollapsedRun = collapsed.evidence.reduce((max, e) => e.runs.reduce((m, r) => Math.max(m, r.count), max), 0);
  const recoveryRun = tailRuns ? [...tailRuns].sort((a, b) => b.count - a.count)[0] : undefined;
  if (tailRuns) collapsed.messages.push(degenerationNotice(tailRuns));
  return {
    messages: collapsed.messages,
    droppedThinkingChars,
    collapsedMessages: collapsed.evidence.length,
    maxCollapsedRun,
    minRun: cfg.minRun,
    recoveryRun,
  };
}

/** Phase 3, AFTER transient nudges: restore host traffic, then sanitize the
 * final provider view. Sanitizing before liveTail would miss orphan results
 * carried by the host; uncompressed branches keep their original pairing. */
export function finalizeOutboundMessages({ messages, liveMessages, liveTail, hasCompression }: {
  messages: AgentMessage[];
  liveMessages: AgentMessage[];
  liveTail: AgentMessage[] | null;
  hasCompression: boolean;
}) {
  const withTail = liveTail?.length ? [...messages, ...liveTail] : messages;
  // System messages carry the active toolset (toolsAdded, #477), so preserve
  // the host's objects/fields verbatim before the final pairing check.
  const withSystem = carryHostSystemMessages(withTail, liveMessages);
  const sanitized = hasCompression ? sanitizeToolPairing(withSystem) : { messages: withSystem, droppedResults: [] };
  return {
    messages: sanitized.messages,
    appendedTail: liveTail?.length ?? 0,
    carriedSystems: withSystem === withTail ? 0 : liveMessages.filter((m) => (m as { role?: unknown }).role === "system").length,
    droppedResults: sanitized.droppedResults,
  };
}
