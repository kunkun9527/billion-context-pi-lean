import { type ExtensionAPI, type ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { AcpRuntime } from "./runtime.js";
export declare function detectBashTimeout(content: ToolResultEvent["content"]): number | undefined;
export declare function appendTimeoutNotice(content: ToolResultEvent["content"], secs: number): ToolResultEvent["content"];
export declare function canonicalStringify(value: unknown): string;
export declare function repetitionFingerprint(toolName: string, input: unknown): string;
export type RepetitionAction = "none" | "warn" | "abort";
export interface RepetitionDecision {
    action: RepetitionAction;
    count: number;
    fingerprint: string;
    toolName: string;
}
export declare class RepetitionTracker {
    private readonly thresholds;
    private lastFp;
    private count;
    constructor(thresholds: {
        warn: number;
        abort: number;
    });
    note(toolName: string, input: unknown): RepetitionDecision;
    reset(): void;
}
export declare function wireToolGuardrails(pi: ExtensionAPI, runtime: AcpRuntime): void;
