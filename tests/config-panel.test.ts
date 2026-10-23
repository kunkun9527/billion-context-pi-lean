import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { PANEL_ITEMS, SearchableList, applyPanelValue, makeConfigCommand, panelDisplay, panelItemsFor, readPanelValue } from "../src/config-panel.js";
import { userConfigPath } from "../src/config-dir.js";
import { updateGlobalAcpConfig } from "../src/user-config.js";
import { createRuntime } from "../src/runtime.js";
import { initTheme } from "@earendil-works/pi-coding-agent";

const scope = { provider: "cliproxyapi", modelId: "claude-opus-5-5" };

test("applyPanelValue: idle settings, per-model compress keys, inherit prunes", () => {
  const raw: Record<string, any> = { idleCompact: true, compressionModelId: "openai/gpt-6-luna" };
  applyPanelValue(raw, "idleMinutes", "20", scope);
  assert.deepEqual(raw.idleCompact, { enabled: true, idleMinutes: 20 });
  applyPanelValue(raw, "idleEnabled", "off", scope);
  assert.equal(raw.idleCompact.enabled, false);

  applyPanelValue(raw, "nudgeGrowthTokens", "100K", scope);
  applyPanelValue(raw, "maxContextLimit", "45%", scope);
  assert.deepEqual(raw.compress.providers.cliproxyapi.models["claude-opus-5-5"], { nudgeGrowthTokens: 100_000, maxContextLimit: 0.45 });
  applyPanelValue(raw, "nudgeGrowthTokens", "inherit", scope);
  applyPanelValue(raw, "maxContextLimit", "inherit", scope);
  assert.equal(raw.compress, undefined, "empty provider/model objects are pruned");

  applyPanelValue(raw, "compressionModelId", "main model", scope);
  assert.equal("compressionModelId" in raw, false);
});

test("inherit keeps sibling keys of other models and providers", () => {
  const raw: Record<string, any> = { compress: { promptPack: "lean", providers: { cliproxyapi: { models: { "claude-opus-5-5": { nudgeGrowthTokens: 100_000, minPressureBenefitTokens: 30_000 } } } } } };
  applyPanelValue(raw, "nudgeGrowthTokens", "inherit", scope);
  assert.deepEqual(raw.compress, { promptPack: "lean", providers: { cliproxyapi: { models: { "claude-opus-5-5": { minPressureBenefitTokens: 30_000 } } } } });
});

test("readPanelValue shows effective values and defaults", () => {
  const adapter = { idleCompact: { enabled: true }, compress: { providers: { cliproxyapi: { models: { "claude-opus-5-5": { nudgeGrowthTokens: 100_000, maxContextLimit: 0.45 } } } } } };
  assert.equal(readPanelValue(adapter, "idleEnabled", scope), "on");
  assert.equal(readPanelValue(adapter, "idleMinutes", scope), "29");
  assert.equal(readPanelValue(adapter, "nudgeGrowthTokens", scope), "100K");
  assert.equal(readPanelValue(adapter, "maxContextLimit", scope), "45%");
  assert.equal(readPanelValue(adapter, "minPressureBenefitTokens", scope), "inherit");
  assert.equal(readPanelValue(adapter, "compressionModelId", scope), "main model");
});

test("per-model items are hidden without a current model", () => {
  assert.equal(panelItemsFor({}).some((i) => i.id === "nudgeGrowthTokens"), false);
  assert.equal(panelItemsFor(scope).some((i) => i.id === "nudgeGrowthTokens"), true);
});

test("updateGlobalAcpConfig keeps unrelated keys and refuses to overwrite broken JSON", async () => {
  const file = userConfigPath(homedir(), "acp.json");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ compressionModelId: "a/b", compress: { promptPack: "lean" } }));
  await updateGlobalAcpConfig((raw) => applyPanelValue(raw, "idleEnabled", "on", scope));
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { compressionModelId: "a/b", compress: { promptPack: "lean" }, idleCompact: { enabled: true } });
  await writeFile(file, "{ broken");
  await assert.rejects(updateGlobalAcpConfig(() => {}));
  assert.equal(await readFile(file, "utf8"), "{ broken");
  await rm(file, { force: true });
});

test("concurrent updateGlobalAcpConfig calls do not drop each other", async () => {
  const file = userConfigPath(homedir(), "acp.json");
  await rm(file, { force: true });
  await Promise.all([
    updateGlobalAcpConfig((raw) => applyPanelValue(raw, "idleEnabled", "on", scope)),
    updateGlobalAcpConfig((raw) => applyPanelValue(raw, "idleMinutes", "20", scope)),
    updateGlobalAcpConfig((raw) => applyPanelValue(raw, "debug", "on", scope)),
  ]);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { idleCompact: { enabled: true, idleMinutes: 20 }, debug: true });
  await rm(file, { force: true });
});

test("panel order puts summary model and idle compact first; idle minutes locks while idle compact is off", () => {
  assert.deepEqual(PANEL_ITEMS.slice(0, 3).map((i) => i.id), ["compressionModelId", "idleEnabled", "idleMinutes"]);
  assert.equal(PANEL_ITEMS.at(-1)!.id, "debug");
  const minutes = PANEL_ITEMS.find((i) => i.id === "idleMinutes")!;
  const off = panelDisplay(minutes, { idleCompact: { enabled: false, idleMinutes: 20 } } as any, scope);
  assert.deepEqual(off, { currentValue: "off", locked: true });
  const on = panelDisplay(minutes, { idleCompact: { enabled: true, idleMinutes: 20 } } as any, scope);
  assert.equal(on.currentValue, "20", "stored minutes come back when the switch is on");
  assert.equal(on.locked, false);
  assert.ok(on.values!.includes("29"));
});

test("summary-model picker: typing filters fuzzily, Enter picks, Esc goes back", () => {
  initTheme("dark");
  const choices = ["main model", "session", "openai/gpt-6-luna", "openai/gpt-6.1-sol", "cliproxyapi/claude-opus-5-5"];
  const picked: (string | undefined)[] = [];
  const list = new SearchableList(choices, "session", (v) => picked.push(v), (t) => t);
  for (const ch of "opus") list.handleInput(ch);
  const shown = list.render(80).join("\n");
  assert.match(shown, /claude-opus-5-5/);
  assert.doesNotMatch(shown, /gpt-6-luna/);
  list.handleInput("\r");
  assert.deepEqual(picked, ["cliproxyapi/claude-opus-5-5"]);

  const back = new SearchableList(choices, "session", (v) => picked.push(v), (t) => t);
  back.handleInput("\x1b");
  assert.deepEqual(picked, ["cliproxyapi/claude-opus-5-5", undefined]);
});

test("/acp-config panel renders, toggles a setting, and saves it to the global acp.json", async () => {
  const file = userConfigPath(homedir(), "acp.json");
  await rm(file, { force: true });
  initTheme("dark");
  const runtime = createRuntime({});
  let rearmed = 0;
  const command = makeConfigCommand(runtime, { noteNudge() {}, takeForcedNudge: () => false, rearm: () => { rearmed++; } });
  let component: any;
  const notices: string[] = [];
  const ctx: any = {
    mode: "tui",
    cwd: dirname(file),
    model: { provider: "cliproxyapi", id: "claude-opus-5-5" },
    modelRegistry: { getAvailable: () => [] },
    ui: {
      notify: (m: string) => notices.push(m),
      custom: async (factory: any) => {
        component = await factory({ requestRender() {} }, { fg: (_c: string, t: string) => t, bold: (t: string) => t }, {}, () => {});
      },
    },
  };
  await command.options.handler("", ctx);
  const lines = component.render(100).join("\n");
  assert.match(lines, /ACP settings/);
  assert.match(lines, /Idle compact/);
  assert.match(lines, /cliproxyapi\/claude-opus-5-5/);
  const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(plain(lines), /Idle minutes\s+off/, "minutes locked while idle compact is off");
  component.handleInput("\x1b[B"); // down: summary model → idle compact
  component.handleInput("\x1b[B"); // down: idle minutes (locked)
  component.handleInput("\r"); // no-op while locked
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(rearmed, 0);
  component.handleInput("\x1b[A"); // back up to idle compact
  component.handleInput("\r"); // idle compact off → on
  for (let i = 0; i < 50 && rearmed === 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.match(plain(component.render(100).join("\n")), /Idle minutes\s+29/, "minutes unlock with the switch");
  assert.deepEqual(notices, []);
  assert.equal(rearmed, 1);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { idleCompact: { enabled: true } });
  assert.equal(runtime.adapter.idleCompact && (runtime.adapter.idleCompact as any).enabled, true, "applied without restart");
  await rm(file, { force: true });
});
