import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type Component } from "@earendil-works/pi-tui";
import type { AdapterConfig } from "./config.js";
import { type IdleCompactHandle } from "./idle-compact.js";
import type { AcpRuntime } from "./runtime.js";
/** `/acp-config`: TUI settings panel over the GLOBAL ~/.pi/acp.json. Values
 *  shown are the effective ones (project acp.json included); changes are
 *  written to the global file and applied at once via reloadConfig. */
export interface PanelScope {
    provider?: string;
    modelId?: string;
}
type Raw = Record<string, unknown>;
export interface PanelItem {
    id: string;
    label: string;
    description: string;
    /** Model-scoped items need a current model. */
    model?: boolean;
    /** Upstream switch: while it reads off, this item shows off and is locked;
     *  its stored value is kept so turning the switch back on restores it. */
    dependsOn?: string;
    values?: (current: string) => string[];
    read(adapter: AdapterConfig, scope: PanelScope): string;
    write(raw: Raw, value: string, scope: PanelScope): void;
}
/** Order = importance: summary model and idle compact first, per-model
 *  compression next, debug last. */
export declare const PANEL_ITEMS: PanelItem[];
export declare function panelItemsFor(scope: PanelScope): PanelItem[];
/** Apply one panel change to a parsed acp.json object (mutates). */
export declare function applyPanelValue(raw: Raw, id: string, value: string, scope: PanelScope): void;
export declare function readPanelValue(adapter: AdapterConfig, id: string, scope: PanelScope): string;
/** What the panel shows for an item: locked at off (no values to cycle) while its upstream is off. */
export declare function panelDisplay(item: PanelItem, adapter: AdapterConfig, scope: PanelScope): {
    currentValue: string;
    values?: string[];
    locked: boolean;
};
export declare function makeConfigCommand(runtime: AcpRuntime, idle: IdleCompactHandle | undefined): {
    name: string;
    options: {
        description: string;
        handler: (_args: string, ctx: ExtensionCommandContext) => Promise<void>;
    };
};
/** Model picker for the summary-model submenu: typing filters (fuzzy, like
 *  Pi's own pickers), arrows move, Enter picks, Esc goes back. */
export declare class SearchableList implements Component {
    private readonly choices;
    private readonly close;
    private readonly dim;
    private readonly input;
    private list;
    constructor(choices: string[], current: string, close: (value?: string) => void, dim: (text: string) => string);
    private rebuild;
    render(width: number): string[];
    invalidate(): void;
    handleInput(data: string): void;
}
export {};
