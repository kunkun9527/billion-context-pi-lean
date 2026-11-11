import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { NudgeDecision } from "acp-kernel";
import { type AdapterConfig } from "./config.js";
export declare function createAcpExtension(adapter?: AdapterConfig): ExtensionFactory;
declare const _default: ExtensionFactory;
export default _default;
export declare function formatNudgeRecord(nudge: NudgeDecision, emergency: boolean): string;
