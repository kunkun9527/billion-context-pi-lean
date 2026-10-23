import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSelectListTheme, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, Input, SelectList, SettingsList, Text, fuzzyFilter, getKeybindings, type Component, type SettingItem } from "@earendil-works/pi-tui";
import type { AdapterConfig, CompressSettings } from "./config.js";
import { resolveCompress } from "./config.js";
import { DEFAULT_IDLE_MINUTES, resolveIdleCompact, type IdleCompactHandle } from "./idle-compact.js";
import type { AcpRuntime } from "./runtime.js";
import { SESSION_MODEL_REF } from "./compress-model.js";
import { updateGlobalAcpConfig } from "./user-config.js";

/** `/acp-config`: TUI settings panel over the GLOBAL ~/.pi/acp.json. Values
 *  shown are the effective ones (project acp.json included); changes are
 *  written to the global file and applied at once via reloadConfig. */

export interface PanelScope {
  provider?: string;
  modelId?: string;
}

const ON = "on";
const OFF = "off";
const INHERIT = "inherit";
const MAIN_MODEL = "main model";

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

const k = (n: number) => (n % 1000 === 0 ? `${n / 1000}K` : String(n));
const parseK = (v: string) => (v.endsWith("K") ? Number(v.slice(0, -1)) * 1000 : Number(v));
const pct = (n: number) => `${Math.round(n * 100)}%`;
const withCurrent = (list: string[], current: string) => (list.includes(current) ? list : [...list, current]);

function obj(parent: Raw, key: string): Raw {
  const v = parent[key];
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Raw;
  const fresh: Raw = {};
  parent[key] = fresh;
  return fresh;
}

/** Drop empty objects left behind along a path after a delete. */
function prune(raw: Raw, path: string[]): void {
  for (let depth = path.length; depth > 0; depth--) {
    let node: unknown = raw;
    for (const key of path.slice(0, depth)) node = (node as Raw | undefined)?.[key];
    if (!node || typeof node !== "object" || Object.keys(node as Raw).length > 0) return;
    let parent: Raw = raw;
    for (const key of path.slice(0, depth - 1)) parent = parent[key] as Raw;
    delete parent[path[depth - 1]!];
  }
}

function idleObject(raw: Raw): Raw {
  if (raw.idleCompact === true) raw.idleCompact = { enabled: true };
  return obj(raw, "idleCompact");
}

function modelPath(scope: PanelScope): string[] {
  return ["compress", "providers", scope.provider!, "models", scope.modelId!];
}

function modelSettings(raw: Raw, scope: PanelScope): Raw {
  let node = raw;
  for (const key of modelPath(scope)) node = obj(node, key);
  return node;
}

function modelValue(adapter: AdapterConfig, scope: PanelScope, key: keyof CompressSettings): unknown {
  return adapter.compress?.providers?.[scope.provider!]?.models?.[scope.modelId!]?.[key];
}

/** Per-model compress keys: "inherit" removes the model-level key so the provider/global/kernel value applies. */
function modelKeyItem(
  id: keyof CompressSettings,
  label: string,
  description: string,
  presets: string[],
  format: (n: number) => string,
  parse: (v: string) => number,
): PanelItem {
  return {
    id,
    label,
    description,
    model: true,
    values: (current) => withCurrent([INHERIT, ...presets], current),
    read(adapter, scope) {
      const v = modelValue(adapter, scope, id);
      if (typeof v === "number") return format(v);
      if (typeof v === "string") return v;
      return INHERIT;
    },
    write(raw, value, scope) {
      const node = modelSettings(raw, scope);
      if (value === INHERIT) {
        delete node[id];
        prune(raw, modelPath(scope));
      } else {
        node[id] = parse(value);
      }
    },
  };
}

/** Order = importance: summary model and idle compact first, per-model
 *  compression next, debug last. */
export const PANEL_ITEMS: PanelItem[] = [
  {
    id: "compressionModelId",
    label: "Summary model",
    description: "Who writes compression summaries. A cheap model saves the main model's tokens; session reuses the current model and its cached prefix; main model lets the main model write them itself.",
    read: (a) => (typeof a.compressionModelId === "string" && a.compressionModelId.trim() ? a.compressionModelId.trim() : MAIN_MODEL),
    write(raw, value) {
      if (value === MAIN_MODEL) delete raw.compressionModelId;
      else raw.compressionModelId = value;
    },
  },
  {
    id: "idleEnabled",
    label: "Idle compact",
    description: "After the session has been idle for the set minutes, start one turn in which the main model decides whether to compress, so you come back to a shorter context instead of paying for a long uncached input.",
    values: () => [ON, OFF],
    read: (a) => (resolveIdleCompact(a.idleCompact).enabled ? ON : OFF),
    write(raw, value) {
      idleObject(raw).enabled = value === ON;
    },
  },
  {
    id: "idleMinutes",
    label: "Idle minutes",
    dependsOn: "idleEnabled",
    description: `Idle time before the idle compact turn (default ${DEFAULT_IDLE_MINUTES}). Keep it a little under your models' prompt-cache lifetime, or that turn itself reads the context uncached.`,
    values: (current) => withCurrent(["10", "15", "20", "25", "29", "45", "55"], current),
    read: (a) => String(resolveIdleCompact(a.idleCompact).idleMinutes),
    write(raw, value) {
      idleObject(raw).idleMinutes = Number(value);
    },
  },
  modelKeyItem("maxContextLimit", "Context threshold", "Share of the window above which the compress nudge stops waiting for Nudge interval and appears whenever Minimum benefit could be reclaimed (default 75%). Not a hard cap. Current model only.", ["40%", "45%", "50%", "60%", "70%", "75%", "80%"], pct, (v) => Number(v.slice(0, -1)) / 100),
  modelKeyItem("nudgeGrowthTokens", "Nudge interval", "Below Context threshold, the compress nudge waits until about this many tokens of old, compressible content have piled up (default 50K). Bigger: fewer nudges, more folded at once. Current model only.", ["30K", "50K", "70K", "100K", "150K", "200K"], k, parseK),
  modelKeyItem("minPressureBenefitTokens", "Minimum benefit", "No compress nudge, and no idle compact turn, when less than this could be reclaimed (default: larger of 5K and 1% of the window). Current model only.", ["5K", "10K", "20K", "30K", "50K"], k, parseK),
  {
    id: "debug",
    label: "Debug log",
    description: "Write detailed events to ~/.pi/acp.log for troubleshooting. Errors and main events are always logged.",
    values: () => [ON, OFF],
    read: (a) => (a.debug === true ? ON : OFF),
    write(raw, value) {
      raw.debug = value === ON;
    },
  },
];

export function panelItemsFor(scope: PanelScope): PanelItem[] {
  return PANEL_ITEMS.filter((item) => !item.model || (scope.provider && scope.modelId));
}

/** Apply one panel change to a parsed acp.json object (mutates). */
export function applyPanelValue(raw: Raw, id: string, value: string, scope: PanelScope): void {
  const item = PANEL_ITEMS.find((i) => i.id === id);
  if (!item) throw new Error(`unknown setting ${id}`);
  item.write(raw, value, scope);
}

export function readPanelValue(adapter: AdapterConfig, id: string, scope: PanelScope): string {
  const item = PANEL_ITEMS.find((i) => i.id === id);
  if (!item) throw new Error(`unknown setting ${id}`);
  return item.read(adapter, scope);
}

/** What the panel shows for an item: locked at off (no values to cycle) while its upstream is off. */
export function panelDisplay(item: PanelItem, adapter: AdapterConfig, scope: PanelScope): { currentValue: string; values?: string[]; locked: boolean } {
  if (item.dependsOn && readPanelValue(adapter, item.dependsOn, scope) === OFF) return { currentValue: OFF, locked: true };
  const currentValue = item.read(adapter, scope);
  return { currentValue, values: item.values?.(currentValue), locked: false };
}

function summaryModelChoices(ctx: ExtensionCommandContext): string[] {
  const models = ctx.modelRegistry.getAvailable();
  return [MAIN_MODEL, SESSION_MODEL_REF, ...models.map((m) => `${m.provider}/${m.id}`)];
}

export function makeConfigCommand(runtime: AcpRuntime, idle: IdleCompactHandle | undefined) {
  return {
    name: "acp-config",
    options: {
      description: "Open the ACP settings panel (Summary model, Idle compact, per-model compression, tool guards).",
      handler: async (_args: string, ctx: ExtensionCommandContext) => {
        if (ctx.mode !== "tui") {
          ctx.ui.notify("/acp-config needs TUI mode; edit ~/.pi/acp.json directly instead", "error");
          return;
        }
        const model = ctx.model as { provider?: string; id?: string } | undefined;
        const scope: PanelScope = { provider: model?.provider, modelId: model?.id };
        const cwd = ctx.cwd ?? process.cwd();
        await runtime.reloadConfig(cwd);
        const items = panelItemsFor(scope);
        const effective = resolveCompress(runtime.adapter.compress, scope.provider, scope.modelId);

        await ctx.ui.custom<void>((tui, theme, _kb, done) => {
          const describe = (item: PanelItem, shown: ReturnType<typeof panelDisplay>) => {
            const upstream = item.dependsOn && items.find((i) => i.id === item.dependsOn);
            const extra = shown.locked && upstream
              ? `Turn on "${upstream.label}" to change this.`
              : item.model && shown.currentValue === INHERIT ? inheritedNote(item.id as keyof CompressSettings, effective) : "";
            return extra ? `${item.description} ${extra}` : item.description;
          };
          const settingItems: SettingItem[] = items.map((item) => {
            const shown = panelDisplay(item, runtime.adapter, scope);
            const setting: SettingItem = { id: item.id, label: item.label, description: describe(item, shown), currentValue: shown.currentValue };
            if (shown.values) setting.values = shown.values;
            if (item.id === "compressionModelId") {
              setting.submenu = (current, close) =>
                new SearchableList(summaryModelChoices(ctx), current, close, (t) => theme.fg("dim", t));
            }
            return setting;
          });

          const container = new Container();
          const where = scope.provider && scope.modelId ? `current model ${scope.provider}/${scope.modelId}` : "no current model, per-model settings hidden";
          container.addChild(new Text(theme.fg("accent", theme.bold("ACP settings")) + theme.fg("dim", `  saved to ~/.pi/acp.json · ${where}`), 0, 0));
          const list = new SettingsList(
            settingItems,
            Math.min(settingItems.length + 2, 15),
            getSettingsListTheme(),
            (id, value) => {
              void save(id, value).catch((e) => ctx.ui.notify(`[ACP] Save failed: ${e instanceof Error ? e.message : String(e)}`, "error"));
            },
            () => done(undefined),
          );
          container.addChild(list);

          const save = async (id: string, value: string) => {
            // setCompressionModelRef also writes the global file and drops the reload cache.
            if (id === "compressionModelId") await runtime.setCompressionModelRef(value === MAIN_MODEL ? null : value);
            else await updateGlobalAcpConfig((raw) => applyPanelValue(raw, id, value, scope));
            await runtime.reloadConfig(cwd);
            if (id === "idleEnabled" || id === "idleMinutes") idle?.rearm();
            const now = readPanelValue(runtime.adapter, id, scope);
            if (now !== value) {
              list.updateValue(id, now);
              ctx.ui.notify(`[ACP] Saved to the global config, but the project .pi/acp.json overrides this setting; in effect: ${now}`, "warning");
            }
            // Lock or unlock items that depend on this switch (SettingsList holds these objects by reference).
            for (const item of items.filter((i) => i.dependsOn === id)) {
              const setting = settingItems.find((s) => s.id === item.id)!;
              const shown = panelDisplay(item, runtime.adapter, scope);
              setting.currentValue = shown.currentValue;
              setting.values = shown.values;
              setting.description = describe(item, shown);
            }
            tui.requestRender();
          };

          return {
            render: (width: number) => container.render(width),
            invalidate: () => container.invalidate(),
            handleInput(data: string) {
              list.handleInput(data);
              tui.requestRender();
            },
          };
        });
      },
    },
  };
}

/** Model picker for the summary-model submenu: typing filters (fuzzy, like
 *  Pi's own pickers), arrows move, Enter picks, Esc goes back. */
export class SearchableList implements Component {
  private readonly input = new Input();
  private list!: SelectList;

  constructor(
    private readonly choices: string[],
    current: string,
    private readonly close: (value?: string) => void,
    private readonly dim: (text: string) => string,
  ) {
    this.input.focused = true;
    this.rebuild("");
    this.list.setSelectedIndex(Math.max(0, choices.indexOf(current)));
  }

  private rebuild(query: string): void {
    const matches = query ? fuzzyFilter(this.choices, query, (c) => c) : this.choices;
    this.list = new SelectList(matches.map((value) => ({ value, label: value })), 12, getSelectListTheme());
    this.list.onSelect = (picked) => this.close(picked.value);
    this.list.onCancel = () => this.close();
  }

  render(width: number): string[] {
    return [this.dim("Type to filter · ↑↓ select · Enter confirm · Esc back"), ...this.input.render(width), ...this.list.render(width)];
  }

  invalidate(): void {
    this.input.invalidate();
    this.list.invalidate();
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    if (["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"].some((id) => kb.matches(data, id as never))) {
      this.list.handleInput(data);
      return;
    }
    const before = this.input.getValue();
    this.input.handleInput(data);
    const after = this.input.getValue();
    if (after !== before) this.rebuild(after);
  }
}

function inheritedNote(id: keyof CompressSettings, effective: CompressSettings): string {
  const v = effective[id];
  if (typeof v === "number") return `Inherited value: ${id === "maxContextLimit" ? pct(v) : k(v)}.`;
  if (typeof v === "string") return `Inherited value: ${v}.`;
  return "";
}
