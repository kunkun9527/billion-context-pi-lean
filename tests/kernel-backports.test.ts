// Kernel fixes back-ported from billion-context's in-repo acp-kernel (0.0.101 → 0.0.180)
// via patches/acp-kernel-0.0.101.patch. See outputs of the 2026-11-04 kernel review.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assignRefs,
  computeFoldEconomics,
  createCore,
  createInitialState,
  defaultConfig,
  truncateLargeToolOutputs,
  type CoreMessage,
} from "acp-kernel";

// ── #3935: an applied truncation clip is always strictly shorter ──────────────
const countTokens = (text: string) => Math.ceil(text.length / 4);
const truncConfig = () => ({ ...defaultConfig(100_000) });
function history(text: string): CoreMessage[] {
  return [
    { id: "t1", role: "tool", contentType: "tool-result", toolCallId: "call-t1", toolName: "read", text },
    { id: "p1", role: "user", contentType: "text", text: "q1" },
    { id: "p2", role: "user", contentType: "text", text: "q2" },
    { id: "p3", role: "user", contentType: "text", text: "q3" },
  ];
}

test("#3935: a just-over-window output clips to something strictly shorter", () => {
  const original = "A".repeat(4001);
  const out = truncateLargeToolOutputs(history(original), 96_000, truncConfig(), countTokens);
  assert.equal(out.truncatedCount, 1);
  const text = out.messages[0]!.text!;
  assert.ok(text.includes("[truncated for context space]"));
  assert.ok(text.length < original.length, `replacement ${text.length} must be < ${original.length}`);
  assert.ok(out.savedTokens > 0);
});

test("#3935: strictly shorter across the whole former bloat window", () => {
  for (const size of [4001, 4010, 4040, 4060, 4067, 4068, 4200, 6000]) {
    const out = truncateLargeToolOutputs(history("A".repeat(size)), 96_000, truncConfig(), countTokens);
    assert.equal(out.truncatedCount, 1, `size ${size}`);
    assert.ok(out.messages[0]!.text!.length < size, `size ${size}: ${out.messages[0]!.text!.length}`);
  }
});

test("#3935: large outputs keep the full 2000+2000 window byte-for-byte", () => {
  const original = "x".repeat(2000) + "M".repeat(396_000) + "y".repeat(2000);
  const out = truncateLargeToolOutputs(history(original), 96_000, truncConfig(), countTokens);
  const text = out.messages[0]!.text!;
  assert.equal(text.length, 4066);
  assert.ok(text.startsWith("x".repeat(2000) + "\n\n...[truncated for context space]"));
  assert.ok(text.endsWith("]...\n\n" + "y".repeat(2000)));
});

test("#3935: deterministic, idempotent, and too-small candidates stay verbatim", () => {
  const a = truncateLargeToolOutputs(history("B".repeat(4037)), 96_000, truncConfig(), countTokens);
  const b = truncateLargeToolOutputs(history("B".repeat(4037)), 96_000, truncConfig(), countTokens);
  assert.equal(a.messages[0]!.text, b.messages[0]!.text);
  const clipped = truncateLargeToolOutputs(history("C".repeat(5000)), 96_000, truncConfig(), countTokens).messages[0]!.text!;
  const again = truncateLargeToolOutputs(history(clipped), 96_000, truncConfig(), countTokens);
  assert.equal(again.truncatedCount, 0);
  assert.equal(again.messages[0]!.text, clipped);
  const small = truncateLargeToolOutputs(history("short payload"), 96_000, truncConfig(), countTokens, { keepPrefixChars: 0, keepSuffixChars: 0, minOutputTokens: 1 });
  assert.equal(small.truncatedCount, 0);
  assert.equal(small.messages[0]!.text, "short payload");
});

// ── #2158: core.search (used by /acp-search) has no relevance floor ──────────
function foldOne(summary: string, topic?: string) {
  const core = createCore();
  const state = createInitialState();
  const messages: CoreMessage[] = Array.from({ length: 8 }, (_, i) => ({ id: `p${i + 1}`, role: i % 2 ? "user" : "assistant", contentType: "text", text: `body ${i + 1} `.repeat(240) }));
  state.messageRefs = assignRefs(messages, { existing: state.messageRefs, nextIndex: 1 }).map;
  const config = defaultConfig(200000, { preserveRecentMessages: 1, preserveRecentTokens: 0 });
  const out = core.applyCompression({ messages, state, config, ranges: [{ startRef: "m00002", endRef: "m00005", summary, topic }] });
  assert.equal(out.result.blocksCreated, 1, out.result.errors.join("; "));
  return { core, state: out.state };
}

test("#2158: a term occurring once in a summary is found", () => {
  const summary = "Investigated the session meter drift; the unique-marker-2026 file holds the trace. Retained decisions and follow-ups for later work.";
  const { core, state } = foldOne(summary);
  assert.deepEqual(core.search("unique-marker-2026", state).map((b) => b.blockId), ["b1"]);
});

test("#2158: CJK single hits match, non-matching queries stay empty, ranking keeps the stronger hit first", () => {
  const { core, state } = foldOne("记录了中文检索的单次命中，并保留后续需要处理的决定与检查结果；另外写明了排查步骤、涉及的配置文件和验证命令，长度足够通过摘要门槛。");
  assert.equal(core.search("中文检索", state).length, 1);
  assert.equal(core.search("nonexistent-term", state).length, 0);
  const strong = foldOne("alpha alpha alpha alpha alpha summary body that is long enough to pass the summary gate for sure.", "alpha");
  const both = { ...strong.state, blocks: [...strong.state.blocks, ...state.blocks.map((b) => ({ ...b, blockId: "b9" }))] };
  assert.equal(strong.core.search("alpha", both)[0]!.blockId, "b1");
});

// ── #2044: payback verdict uses the full post-fold window ────────────────────
const fold = (over: Record<string, unknown>) => ({ seq: 1, at: 0, S: 1000, sigma: 0, T: 1000, hPct: null, requestsAfter: 10, turnsToNextFold: null, ...over }) as any;

test("#2044: the last fold is evaluable from requests observed so far", () => {
  // n* = ((1-0.1)*1000 - 0.1*1000) / (0.1*1000) = 8
  const e = computeFoldEconomics(fold({ requestsAfter: 10, turnsToNextFold: null })) as any;
  assert.equal(e.breakevenTurns, 8);
  assert.equal(e.paidBack, true);
  assert.equal(e.cadenceOk, null);
  assert.equal((computeFoldEconomics(fold({ requestsAfter: 3, turnsToNextFold: null })) as any).paidBack, false);
});

test("#2044: back-to-back folds keep the short-window signal as cadenceOk only", () => {
  const e = computeFoldEconomics(fold({ requestsAfter: 10, turnsToNextFold: 3 })) as any;
  assert.equal(e.paidBack, true, "lifetime verdict agrees with savedSoFar");
  assert.equal(e.cadenceOk, false, "folded again before n*");
  assert.equal((computeFoldEconomics(fold({ S: 0 })) as any).paidBack, null, "S ≤ σ stays unobservable");
});
