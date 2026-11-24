import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
/** Sentinel compressionModelId value meaning "use the session's own model".
 *  The compression call reuses the session's prompt prefix (system prompt +
 *  tools + messages) so it can hit the provider's prompt cache. Distinct from a
 *  model ref ("provider/id" or a bare id). */
export declare const SESSION_MODEL_REF = "session";
/** A model known to Pi's model registry, addressed by provider + id. */
export interface CompressionModelInfo {
    provider: string;
    id: string;
    name?: string;
}
/** `model` is set when the ref is unambiguous; `ambiguous` lists candidates
 *  when a bare id matches several providers. */
export interface ResolveResult {
    model: Model<Api> | null;
    ambiguous: CompressionModelInfo[];
}
type ModelRegistryLike = ExtensionContext["modelRegistry"];
/** Nested-call method on the host registry: `streamSimple` for Google
 *  thinking models on the extracted-content path, `complete` otherwise.
 *  Gemini counts thoughts toward maxOutputTokens, and `complete()` sends no
 *  thinkingConfig, so Gemini thinks at its dynamic default and can use up the
 *  summary budget (#6). `streamSimple` with `reasoning: "minimal"` lets Pi pick
 *  the model's lowest level (2.5 Pro cannot turn thinking off, so "off" would
 *  be rejected there). A shared session prefix keeps `complete()`: changing
 *  thinking settings can cost the prompt-cache hit that path exists for. */
export declare function summaryCallMethod(model: Model<Api>, sharedPrefix: boolean): "complete" | "streamSimple";
/** Every chat model Pi knows, including providers registered by extensions
 *  (the session's live registry — not a private models.json-only runtime). */
export declare function listModels(registry: ModelRegistryLike): CompressionModelInfo[];
/** Resolve "provider/id" (explicit, split at the first slash) or a bare id. */
export declare function resolveModel(registry: ModelRegistryLike, ref: string): ResolveResult;
/** Run one summary call through the session's model registry (request-time
 *  auth, extension-registered providers). Throws on host without nested
 *  completion support, API error, abort, or empty output — the caller then
 *  keeps the main model's fallback summary. */
export declare function summarizeWithModel(ctx: ExtensionContext, model: Model<Api>, context: Context, maxTokens: number, signal?: AbortSignal, method?: "complete" | "streamSimple"): Promise<string>;
/** The leaked text (trimmed) when the opening of `summary` is planning, else null. */
export declare function detectPlanningLeak(summary: string): string | null;
/** The echoed text when `summary` contains copied transcript entries, else null. */
export declare function detectTranscriptEcho(summary: string): string | null;
export type SummaryDefect = "planning" | "transcript-echo";
/** summarizeWithModel, plus one retry when the output opens with planning
 *  text or copies transcript entries. A second defective output throws, so
 *  the range is not folded (the caller retries later) — never stored, never
 *  silently stripped. */
export declare function summarizeChecked(ctx: ExtensionContext, model: Model<Api>, context: Context, maxTokens: number, signal?: AbortSignal, onDefect?: (text: string, kind: SummaryDefect) => void, method?: "complete" | "streamSimple"): Promise<string>;
/** System prompt for a dedicated model: reuse the kernel's tier-1 rules so
 *  its output matches what the main model would produce. */
export declare function buildSummarizeSystemPrompt(prompts: {
    compressPhilosophy: string;
    howToCompressRules: string;
}, topic: string | undefined): string;
/** Truncate very large content, keeping head (goal/early context) and tail
 *  (latest state) around a marker. */
export declare function truncateContent(content: string, maxChars: number): string;
/** A chunk of range content; pinned chunks (earlier block summaries) are never truncated. */
export interface ContentPart {
    text: string;
    pinned?: boolean;
}
/** Fit extracted range content into the summary model's context window
 *  instead of a fixed 120K-char cap; truncate only what cannot fit.
 *  When truncation is needed, pinned parts (earlier block summaries) are
 *  kept whole and listed first, and only the raw messages are cut — the
 *  summaries carry the decisions the new summary must inherit. Pinned parts
 *  that cannot fit whole throw: the caller then keeps its own summary, written
 *  by the main model that saw them in full, instead of one that lost facts. */
export declare function fitToModel(parts: ContentPart[], model: {
    contextWindow?: number;
}, maxTokens: number): string;
export {};
