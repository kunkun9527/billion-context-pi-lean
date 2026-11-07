import type { CompressionCore, CompressionState } from "acp-kernel";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
type ApplyInput = Parameters<CompressionCore["applyCompression"]>[0];
export interface RebuildReport {
    blocks: number;
    callsApplied: number;
    callsSkipped: number;
    errors: string[];
}
export interface RebuildResult {
    state: CompressionState;
    report: RebuildReport;
}
/** Cheap scan: does this log contain at least one non-error compress toolResult? */
export declare function hasCompressHistory(entries: SessionEntry[]): boolean;
/**
 * Replay successful compress calls from the session log against `state`
 * (normally a fresh createInitialState()). Failed, errored, no-op and
 * unparseable calls are skipped. Partial successes replay their recorded
 * applied ranges when available. `report.blocks` tells the caller
 * whether anything was actually rebuilt (state is returned unchanged when
 * nothing applied).
 */
export declare function rebuildStateFromLog(input: {
    entries: SessionEntry[];
    state: CompressionState;
    config: ApplyInput["config"];
    core: CompressionCore;
}): RebuildResult;
export {};
