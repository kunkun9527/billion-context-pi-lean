import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSelectListTheme, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, Input, SelectList, SettingsList, Text, fuzzyFilter, getKeybindings, type Component, type SettingItem } from "@earendil-works/pi-tui";
import type { AdapterConfig, CompressSettings } from "./config.js";
import { DEFAULT_PRESERVE_RECENT_MESSAGES, DEFAULT_PRESERVE_RECENT_TOKENS, resolveCompress } from "./config.js";
import { DEFAULT_IDLE_MINUTES, resolveIdleCompact, type IdleCompactHandle } from "./idle-compact.js";
import type { AcpRuntime } from "./runtime.js";
import { SESSION_MODEL_REF } from "./compress-model.js";
import { updateGlobalAcpConfig } from "./user-config.js";
import { matchToolPattern } from "acp-kernel";

/** `/acp-config`: TUI settings panel over the GLOBAL ~/.pi/acp.json. Values
 *  shown are the effective ones (project acp.json included); changes are
 *  written to the global file and applied at once via reloadConfig. */

export interface PanelScope {
  provider?: string;
  modelId?: string;
}

const ON = "on";
const OFF = "off";
const TOOL_OUTPUT = "tool-output";
const INHERIT = "inherit";
const MAIN_MODEL = "main model";

type Raw = Record<string, unknown>;

export interface PanelItem {
  id: string;
  label: string;
  description: string;
  /** Built-in value when acp.json does not set the key; shown on its own line under the description. */
  defaultValue: string;
  /** Model-scoped items need a current model. */
  model?: boolean;
  /** Upstream switch: while it reads off, this item shows off and is locked;
   *  its stored value is kept so turning the switch back on restores it. */
  dependsOn?: string;
  values?: (current: string) => string[];
  /** Number items: typing a number edits the value in place; it must be a whole number in this range. */
  custom?: NumberRange;
  read(adapter: AdapterConfig, scope: PanelScope): string;
  write(raw: Raw, value: string, scope: PanelScope): void;
}

const k = (n: number) => (n !== 0 && n % 1000 === 0 ? `${n / 1000}K` : String(n));
const parseK = (v: string) => (v.endsWith("K") ? Number(v.slice(0, -1)) * 1000 : Number(v));
const pct = (n: number) => `${Math.round(n * 100)}%`;
const withCurrent = (list: string[], current: string) => (list.includes(current) ? list : [...list, current]);

/** Panel-only bounds for typed values; acp.json keeps its own, looser checks. */
export interface NumberRange {
  min: number;
  max: number;
  unit: "%" | "tokens" | "minutes" | "messages";
}
const PERCENT: NumberRange = { min: 1, max: 100, unit: "%" };
const TOKENS: NumberRange = { min: 0, max: 1_000_000, unit: "tokens" };

function rangeText(r: NumberRange): string {
  if (r.unit === "%") return `${r.min}%–${r.max}%`;
  if (r.unit === "tokens") return `${k(r.min)}–${r.max === 1_000_000 ? "1M" : k(r.max)} tokens`;
  return `${r.min}–${r.max} ${r.unit}`;
}

/** Turn typed text into a panel value (same format as the presets), or say what is wrong.
 *  Whole numbers only, so the saved value reads back exactly as typed. Empty means
 *  inherit on per-model items. */
export function parseCustomValue(item: PanelItem, text: string): { value: string } | { error: string } {
  const r = item.custom;
  if (!r) throw new Error(`${item.id} takes no typed value`);
  const t = text.trim();
  if (t === "") return item.model ? { value: INHERIT } : { error: "Type a number." };
  const m = (r.unit === "%" ? /^(\d+(?:\.\d+)?)\s*(%)?$/ : r.unit === "tokens" ? /^(\d+(?:\.\d+)?)\s*([kK])?$/ : /^(\d+(?:\.\d+)?)()$/).exec(t);
  const n = m ? Number(m[1]) * (r.unit === "tokens" && m[2] ? 1000 : 1) : NaN;
  if (!Number.isInteger(n)) {
    return { error: r.unit === "%" ? "Type a whole percent, like 85 or 85%." : r.unit === "tokens" ? "Type a whole number of tokens, like 20000 or 20K." : "Type a whole number." };
  }
  if (n < r.min || n > r.max) return { error: `Out of range: ${rangeText(r)}.` };
  return { value: r.unit === "%" ? `${n}%` : r.unit === "tokens" ? k(n) : String(n) };
}

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
  defaultValue: string,
  presets: string[],
  format: (n: number) => string,
  parse: (v: string) => number,
  custom: NumberRange,
): PanelItem {
  return {
    id,
    label,
    description,
    defaultValue,
    model: true,
    custom,
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
    defaultValue: MAIN_MODEL,
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
    defaultValue: OFF,
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
    defaultValue: String(DEFAULT_IDLE_MINUTES),
    description: `Idle time before the idle compact turn. Keep it a little under your models' prompt-cache lifetime, or that turn itself reads the context uncached.`,
    values: (current) => withCurrent(["10", "15", "20", "25", "29", "45", "55"], current),
    custom: { min: 1, max: 1440, unit: "minutes" },
    read: (a) => String(resolveIdleCompact(a.idleCompact).idleMinutes),
    write(raw, value) {
      idleObject(raw).idleMinutes = Number(value);
    },
  },
  modelKeyItem("maxContextLimit", "Context threshold", "When the context grows past this share of the window, the model is reminded to compress more often: whenever at least Minimum benefit could be freed, instead of waiting for Nudge interval. Not a hard cap: the context can still grow beyond it. Current model only.", "75%", ["40%", "45%", "50%", "60%", "70%", "75%", "80%"], pct, (v) => Number(v.slice(0, -1)) / 100, PERCENT),
  modelKeyItem("emergencyThresholdPercent", "Emergency threshold", "Last-resort safety net. Once the context reaches this share of the window, older big tool outputs and long messages are cut down to their beginning and end, with no summary, so the session does not overflow. The newest messages (as many as Recent messages) are left alone. If you set it below Context threshold, Context threshold drops to match, so compress reminders start no later than truncation; when the two are equal, both happen on the same turn. Current model only.", "95%", ["80%", "85%", "90%", "95%", "98%"], pct, (v) => Number(v.slice(0, -1)) / 100, PERCENT),
  modelKeyItem("nudgeGrowthTokens", "Nudge interval", "Until Context threshold is reached, the model is reminded to compress only after about this many tokens of old content have piled up. Bigger: fewer reminders, more folded each time. Smaller: frequent small compressions. Current model only.", "50K", ["30K", "50K", "70K", "100K", "150K", "200K"], k, parseK, TOKENS),
  modelKeyItem("minPressureBenefitTokens", "Minimum benefit", "No reminder to compress, and no idle compact, when less than this could be freed: saving a few thousand tokens isn't worth breaking the cache. Current model only.", "larger of 5K and 1% of the window", ["5K", "10K", "20K", "30K", "50K"], k, parseK, TOKENS),
  {
    id: "preserveRecentMessages",
    label: "Recent messages",
    description: "How many of the newest messages compress must leave alone. Each tool call and each result counts as one. read and bash output is not counted and can be folded right away, because it is easy to get again (Protect recent reads keeps reads). Unless this is 0, your latest message is kept too. Emergency truncation also spares this many newest messages, counting everything. All models.",
    defaultValue: String(DEFAULT_PRESERVE_RECENT_MESSAGES),
    values: (current) => withCurrent(["0", "1", "3", "5", "8", "10", "15", "20"], current),
    custom: { min: 0, max: 200, unit: "messages" },
    read: (a) => String(a.preserveRecentMessages ?? DEFAULT_PRESERVE_RECENT_MESSAGES),
    write(raw, value) {
      raw.preserveRecentMessages = Number(value);
    },
  },
  {
    id: "preserveRecentTokens",
    label: "Recent tokens",
    description: "Compress also leaves alone the newest messages, up to about this many tokens. Whichever of this and Recent messages covers more applies. Skips the same tools as Recent messages. 0 turns it off. Emergency truncation ignores it. All models.",
    defaultValue: k(DEFAULT_PRESERVE_RECENT_TOKENS),
    values: (current) => withCurrent(["0", "2K", "5K", "10K", "20K", "50K"], current),
    custom: TOKENS,
    read: (a) => k(a.preserveRecentTokens ?? DEFAULT_PRESERVE_RECENT_TOKENS),
    write(raw, value) {
      raw.preserveRecentTokens = parseK(value);
    },
  },
  {
    id: "protectRecentReads",
    label: "Protect recent reads",
    description: "Off: a file the model just read can be folded right away, like bash output. On: recent read results are kept like other tools' results, so the recent zone gets a bit bigger. Turn on if the model keeps re-reading the same file. Patterns you wrote by hand in acp.json, such as \"r*\", are respected but not edited. All models.",
    defaultValue: OFF,
    values: () => [ON, OFF],
    read: (a) => (readsProtected(a) ? ON : OFF),
    write(raw, value) {
      const isRead = (t: unknown) => typeof t === "string" && t.trim().toLowerCase() === "read";
      const preserve = Array.isArray(raw.preserveRecentTools) ? (raw.preserveRecentTools as unknown[]).filter((t) => !isRead(t)) : [];
      if (value === ON) preserve.push("read");
      if (preserve.length > 0) raw.preserveRecentTools = preserve;
      else delete raw.preserveRecentTools;
      // An explicit never-list that does not match read protects reads by itself; off has to exclude them there too.
      const never = raw.neverPreserveRecentTools;
      if (value === OFF && Array.isArray(never) && !never.some((t) => typeof t === "string" && matchToolPattern("read", t.trim()))) never.push("read");
    },
  },
  {
    id: "claudeFoldAnchor",
    label: "Claude fold anchor",
    defaultValue: ON,
    description: "Claude models through a *responses API only. Keeps the prompt cache alive after a compress: the part of the history that compress won't touch gets a cache mark, so the next request doesn't pay full price for it again. tool-output may also put the mark on a tool output, which usually keeps more cached (needs CLIProxyAPI 8.1.1+; other endpoints may reject it). Other models ignore this. Stored as the global compress.claudeFoldAnchor.",
    values: () => [ON, TOOL_OUTPUT, OFF],
    read: (a) => {
      const v = a.compress?.claudeFoldAnchor;
      return v === false ? OFF : v === TOOL_OUTPUT ? TOOL_OUTPUT : ON;
    },
    write(raw, value) {
      if (value === OFF || value === TOOL_OUTPUT) obj(raw, "compress").claudeFoldAnchor = value === OFF ? false : TOOL_OUTPUT;
      else {
        delete obj(raw, "compress").claudeFoldAnchor;
        prune(raw, ["compress"]);
      }
    },
  },
  {
    id: "debug",
    label: "Debug log",
    description: "Write detailed events to ~/.pi/acp.log for troubleshooting. Errors and main events are always logged.",
    defaultValue: OFF,
    values: () => [ON, OFF],
    read: (a) => (a.debug === true ? ON : OFF),
    write(raw, value) {
      raw.debug = value === ON;
    },
  },
];

/** Mirrors the kernel's isNeverPreserveRecent for the tool "read": the
 *  exclusion list is (neverPreserveRecentTools ?? built-in) minus entries a
 *  preserveRecentTools pattern matches, and reads are protected unless an
 *  entry left matches "read" (glob suffix, case-insensitive). Of the
 *  built-in entries only "read" itself matches, so ["read"] stands in for it. */
function readsProtected(a: AdapterConfig): boolean {
  const preserve = a.preserveRecentTools ?? [];
  const excluded = (a.neverPreserveRecentTools ?? ["read"]).filter((t) => !preserve.some((p) => matchToolPattern(t, p)));
  return !excluded.some((t) => matchToolPattern("read", t));
}

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
            const own = item.custom && shown.values ? `\nOr type your own: ${rangeText(item.custom)}${item.model ? ", empty = inherit" : ""}.` : "";
            return `${extra ? `${item.description} ${extra}` : item.description}${own}\nDefault: ${item.defaultValue}.`;
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
          // Typing a number on a number item edits its value in place.
          let editing: { item: PanelItem; setting: SettingItem; text: string; before: string; description: string } | undefined;
          const listTheme = getSettingsListTheme();
          const list = new SettingsList(
            settingItems,
            Math.min(settingItems.length + 2, 15),
            {
              ...listTheme,
              // SettingsList's hint text is fixed; name the extra keys this panel adds.
              hint: (text) => listTheme.hint(editing ? "  Enter to save · Backspace to edit · Esc to cancel" : text.replace("Enter/Space to change", "←→ or Enter/Space to change · type a number for your own")),
            },
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
              ctx.ui.notify(`[ACP] Saved to the global config, but the project .pi/acp.json or a hand-written pattern decides this setting; in effect: ${now}`, "warning");
            }
            // Refresh this item (a typed value joins its cycle) and lock or unlock items that
            // depend on this switch (SettingsList holds these objects by reference).
            for (const item of items.filter((i) => i.id === id || i.dependsOn === id)) {
              const setting = settingItems.find((s) => s.id === item.id)!;
              const shown = panelDisplay(item, runtime.adapter, scope);
              setting.currentValue = shown.currentValue;
              setting.values = shown.values;
              setting.description = describe(item, shown);
            }
            tui.requestRender();
          };

          const commit = (id: string, value: string) => {
            void save(id, value).catch((e) => ctx.ui.notify(`[ACP] Save failed: ${e instanceof Error ? e.message : String(e)}`, "error"));
          };
          const stopEditing = (restore: boolean) => {
            if (!editing) return;
            if (restore) editing.setting.currentValue = editing.before;
            editing.setting.description = editing.description;
            editing = undefined;
          };
          const showDraft = (error = "") => {
            if (!editing) return;
            editing.setting.currentValue = `${editing.text}▏`;
            editing.setting.description = error ? `${editing.description}\n${theme.fg("warning", error)}` : editing.description;
          };
          // SettingsList keeps these private and exposes no getter; the panel tests pin them.
          const listState = list as unknown as { selectedIndex: number; submenuComponent: Component | null };
          const handleEdit = (data: string) => {
            const kb = getKeybindings();
            const e = editing!;
            if (kb.matches(data, "tui.select.confirm")) {
              const r = parseCustomValue(e.item, e.text);
              if ("error" in r) return showDraft(r.error);
              stopEditing(false);
              e.setting.currentValue = r.value;
              commit(e.item.id, r.value);
            } else if (kb.matches(data, "tui.select.cancel")) {
              stopEditing(true);
            } else if (kb.matches(data, "tui.editor.deleteCharBackward")) {
              e.text = e.text.slice(0, -1);
              showDraft();
            } else if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
              stopEditing(true);
              list.handleInput(data);
            } else if (/^[0-9.%kK]$/.test(data) && e.text.length < 12) {
              e.text += data;
              showDraft();
            }
          };

          return {
            render: (width: number) => container.render(width),
            invalidate: () => container.invalidate(),
            handleInput(data: string) {
              const kb = getKeybindings();
              const setting = listState.submenuComponent ? undefined : settingItems[listState.selectedIndex];
              const item = setting && items.find((i) => i.id === setting.id);
              const values = setting?.values;
              const step = kb.matches(data, "tui.editor.cursorRight") ? 1 : kb.matches(data, "tui.editor.cursorLeft") ? -1 : 0;
              if (editing) {
                handleEdit(data);
              } else if (step && setting && values && values.length > 0 && !setting.submenu) {
                const at = values.indexOf(setting.currentValue);
                const next = values[at < 0 ? (step > 0 ? 0 : values.length - 1) : (at + step + values.length) % values.length]!;
                setting.currentValue = next;
                commit(setting.id, next);
              } else if (item?.custom && setting && values && /^[0-9]$/.test(data)) {
                editing = { item, setting, text: data, before: setting.currentValue, description: setting.description ?? "" };
                showDraft();
              } else {
                list.handleInput(data);
              }
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
  if (typeof v === "number") return `Inherited value: ${id === "maxContextLimit" || id === "emergencyThresholdPercent" ? pct(v) : k(v)}.`;
  if (typeof v === "string") return `Inherited value: ${v}.`;
  return "";
}
