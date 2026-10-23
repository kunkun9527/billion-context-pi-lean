import type { Prompts } from "acp-kernel";
import type { AdapterConfig, CompressConfig, RepetitionGuardConfig } from "./config.js";
import type { PiPromptSections } from "./system-prompt.js";
import type { NudgeSectionsConfig, ToolPromptsConfig } from "./surface.js";
import type { DegenerationGuardConfig } from "./degeneration.js";
import type { ThrottleRetryConfig } from "./throttle-retry.js";
import type { IdleCompactConfig } from "./idle-compact.js";
/** User-facing config keys (subset of AdapterConfig). Loaded from
 *  ~/.<CONFIG_DIR_NAME>/acp.json (global) and <cwd>/.<CONFIG_DIR_NAME>/acp.json
 *  (project-local overrides project-global). Project wins over global. */
export interface UserAcpConfig {
    enabled?: boolean;
    debug?: boolean;
    modelContextLimit?: number;
    protectedTools?: string[];
    protectedLatestTools?: string[];
    neverPreserveRecentTools?: string[];
    preserveRecentTools?: string[];
    compress?: CompressConfig;
    outputHeadroomMaxPct?: number | string;
    throttleRetry?: boolean | ThrottleRetryConfig;
    idleCompact?: boolean | IdleCompactConfig;
    repetitionGuard?: boolean | RepetitionGuardConfig;
    degenerationGuard?: boolean | DegenerationGuardConfig;
    prompts?: Partial<Prompts>;
    acknowledgePromptsRisk?: boolean;
    promptSections?: PiPromptSections;
    nudgeSections?: NudgeSectionsConfig;
    toolPrompts?: ToolPromptsConfig;
    rules?: boolean;
    compressionModelId?: string;
}
/** Read global + project acp.json, project overrides global. Returns {} on any
 *  error (missing file, bad JSON) — never throws. Malformed-but-repairable
 *  files are salvaged with a loud warning instead of silently meaning "not
 *  disabled" / "no config" (#467). */
export declare function loadUserConfig(cwd: string): Promise<UserAcpConfig>;
export interface AcpJsonParse {
    status: "ok" | "repaired" | "failed";
    value?: Record<string, unknown>;
    reason?: string;
}
/** Lenient parse of a hand-edited acp.json (#467): strict JSON first, then
 *  repair the common hand-edit shapes (BOM head, trailing commas, unquoted
 *  keys) with a loud warning, then give up with a diagnosed reason. The
 *  enabled:false master switch must survive a notepad edit — silently
 *  treating the user's file as absent is the exact opposite of intent. */
export declare function parseAcpJson(file: string, raw: string): AcpJsonParse;
/** Merge user config onto an adapter config: user config wins for the keys it
 *  sets. Used at session_start to apply runtime-discovered config. The two
 *  protection keys are shape-checked here because acp.json is hand-edited JSON
 *  and a malformed value must warn + fall back, never fail the session or feed
 *  garbage to the kernel (#499). */
export declare function applyUserConfig(adapter: AdapterConfig, user: UserAcpConfig): AdapterConfig;
/** Persist compressionModelId in the GLOBAL acp.json while preserving every
 *  other key (#241 port, `/acp compact`). null removes it. Project-level
 *  acp.json still overrides the global value. A present-but-unparseable file
 *  is never overwritten. */
export declare function saveCompressionModelId(value: string | null): Promise<void>;
/** Read-modify-write the GLOBAL acp.json, keeping every key the mutator does
 *  not touch. A present-but-unparseable file is never overwritten. Calls are
 *  serialized so quick successive changes (settings panel) never read the same
 *  old snapshot and drop each other. */
export declare function updateGlobalAcpConfig(mutate: (current: Record<string, unknown>) => void): Promise<void>;
