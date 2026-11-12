// Claude cache anchor for the Responses wire format (on by default; turn off
// with acp.json `compress.claudeFoldAnchor: false`). The next fold most likely starts at the earliest
// compressible range, so everything before it survives that fold unchanged.
// CLIProxyAPI only places breakpoints on the system prompt and the latest
// message, so that stable prefix is rewritten after every fold. Marking the
// last text part before the range lets Claude cache it. CLIProxyAPI forwards
// part-level `cache_control` on input_text/output_text parts (but not on
// function_call / function_call_output items), hence "last text part".
// When no range remains (right after the last fold) src/index.ts keeps the
// previous start: the prefix before it is unchanged and already cached.

// The host appends exactly one ref tag at the END of a user text part or a
// tool output; tags quoted elsewhere in text (e.g. a user pasting old output)
// must not count, so only a trailing tag is a real ref.
const TRAILING_REF_TAG = /<acp\b[^>]*>m(\d{5,})<\/acp>\s*$/;

/** The anchor applies only when enabled in config AND the live model is a
 *  Claude model on a `*responses` API (the wire format handled here). */
export function claudeFoldAnchorApplies(enabled: boolean | undefined, model: { api?: string; id?: string } | undefined): boolean {
  return enabled !== false && /responses$/.test(model?.api ?? "") && /claude/i.test(model?.id ?? "");
}

function refNumber(ref: string): number | undefined {
  const m = /^m(\d+)$/.exec(ref);
  return m ? Number(m[1]) : undefined;
}

function itemTexts(item: unknown): string[] {
  if (!item || typeof item !== "object") return [];
  const { content, output } = item as { content?: unknown; output?: unknown };
  const out: string[] = [];
  if (typeof output === "string") out.push(output);
  for (const list of [content, output]) {
    if (!Array.isArray(list)) continue;
    for (const part of list) {
      const text = (part as { text?: unknown } | undefined)?.text;
      if (typeof text === "string") out.push(text);
    }
  }
  if (typeof content === "string") out.push(content);
  return out;
}

function itemRefs(item: unknown): number[] {
  const refs: number[] = [];
  for (const text of itemTexts(item)) {
    const m = TRAILING_REF_TAG.exec(text);
    if (m) refs.push(Number(m[1]));
  }
  return refs;
}

/** Earliest ref by numeric order (refs may outgrow 5 digits). */
export function earliestRef(refs: string[]): string | undefined {
  let best: string | undefined;
  let bestNum = Infinity;
  for (const ref of refs) {
    const n = refNumber(ref);
    if (n !== undefined && n < bestNum) {
      best = ref;
      bestNum = n;
    }
  }
  return best;
}

function lastTextPart(item: unknown): Record<string, unknown> | undefined {
  if (!item || typeof item !== "object") return undefined;
  const content = (item as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  for (let i = content.length - 1; i >= 0; i--) {
    const part = content[i] as Record<string, unknown> | undefined;
    if ((part?.type === "input_text" || part?.type === "output_text") && typeof part.text === "string" && part.text.trim()) {
      return part;
    }
  }
  return undefined;
}

export interface FoldAnchorOutcome {
  body?: unknown;
  /** Index of the anchored input item, when one was marked. */
  index?: number;
  reason?: string;
}

/** Mark the last text part that precedes `startRef` (the earliest compressible
 *  message, or the previous one when none remains; it may already be folded
 *  away — the scan compares ref numbers, so it need not appear in the body).
 *  Conservative: the anchor sits at or before the last tagged item
 *  whose ref is below `startRef`, so untagged assistant items belonging to the
 *  range can never be anchored. Pure: returns a shallow-copied body. */
export function applyFoldAnchor(body: unknown, startRef: string | undefined): FoldAnchorOutcome {
  const start = startRef ? refNumber(startRef) : undefined;
  if (start === undefined) return { reason: "no-range" };
  const input = (body as { input?: unknown } | undefined)?.input;
  if (!Array.isArray(input)) return { reason: "no-input" };

  let boundary = -1;
  for (let i = 0; i < input.length; i++) {
    const refs = itemRefs(input[i]);
    if (refs.some((r) => r >= start)) break;
    if (refs.length > 0) boundary = i;
  }
  if (boundary < 0) return { reason: "no-boundary" };

  for (let i = boundary; i >= 0; i--) {
    const part = lastTextPart(input[i]);
    if (!part) continue;
    if (part.cache_control) return { reason: "already-marked", index: i };
    const item = input[i] as { content: unknown[] };
    const content = item.content.map((p) => (p === part ? { ...part, cache_control: { type: "ephemeral" } } : p));
    const nextInput = [...input];
    nextInput[i] = { ...item, content };
    return { body: { ...(body as object), input: nextInput }, index: i };
  }
  return { reason: "no-text-part" };
}
