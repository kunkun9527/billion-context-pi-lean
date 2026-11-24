// First request after each successful compress fold: cacheRead vs uncached input,
// split at a timestamp (e.g. a CLIProxyAPI upgrade). Forked copies are counted once.
// node scripts/replay/post-fold-cache.mjs --split 2026-11-23T14:32:18Z [--days 14] [--model claude-opus-5-5] [--sessions DIR]
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const split = Date.parse(arg("split", ""));
if (Number.isNaN(split)) throw new Error("--split <ISO timestamp> is required");
const model = arg("model", "claude-opus-5-5");
const cutoff = Date.now() - Number(arg("days", "14")) * 86_400_000;
const root = arg("sessions", join(homedir(), ".pi", "agent", "sessions"));

function* jsonlFiles(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* jsonlFiles(p);
    else if (name.endsWith(".jsonl") && st.mtimeMs >= cutoff) yield p;
  }
}

// Blocks created by a compress result, mirroring compressPanelBlocks (src/compress-tool.ts):
// a 0-block panel or an error folded nothing and is not a fold.
function panelBlocks(result) {
  const text = (result.content ?? []).map((p) => p.text ?? "").join("");
  if (!text.trimStart().startsWith("▣ ACP |")) return 0;
  const legacy = text.match(/, (\d+) blocks?\)/);
  if (legacy) return Number(legacy[1]);
  const idx = text.indexOf(", blocks: ");
  if (idx === -1) return 0;
  return (text.slice(idx).split("\n", 1)[0] ?? "").match(/\bb\d+(?:\(T\d+\))?=/g)?.length ?? 0;
}

const seen = new Set();
const rows = { before: [], after: [] };
const isModel = (m) => m?.role === "assistant" && String(m.model).includes(model);
for (const file of jsonlFiles(root)) {
  const msgs = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    try {
      const e = JSON.parse(line);
      if (e.type === "message") msgs.push(e.message);
    } catch {}
  }
  msgs.forEach((m, i) => {
    if (!isModel(m)) return;
    const ids = new Set((m.content ?? []).filter((p) => p.type === "toolCall" && p.name === "compress").map((p) => p.id));
    if (!ids.size) return;
    const nextAt = msgs.findIndex((r, j) => j > i && r.role === "assistant");
    const results = msgs.slice(i + 1, nextAt < 0 ? undefined : nextAt);
    if (!results.some((r) => r.role === "toolResult" && ids.has(r.toolCallId) && !r.isError && panelBlocks(r) > 0)) return;
    const next = msgs[nextAt];
    if (!isModel(next) || !next.usage || (next.timestamp ?? 0) < cutoff) return;
    const u = next.usage;
    const key = `${next.timestamp}|${u.input}|${u.cacheRead}`;
    if (seen.has(key)) return;
    seen.add(key);
    const read = u.cacheRead ?? 0, input = u.input ?? 0, total = read + input + (u.cacheWrite ?? 0);
    rows[next.timestamp >= split ? "after" : "before"].push({ read, input, hit: total ? read / total : 0 });
  });
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2 : NaN;
};
for (const [k, r] of Object.entries(rows)) {
  if (!r.length) { console.log(`${k}: n=0`); continue; }
  const pct = (x) => `${Math.round(100 * x)}%`;
  console.log(`${k}: n=${r.length} median cacheRead=${(median(r.map((x) => x.read)) / 1e3).toFixed(1)}K ` +
    `median uncached=${(median(r.map((x) => x.input)) / 1e3).toFixed(1)}K median hit=${pct(median(r.map((x) => x.hit)))} ` +
    `mean hit=${pct(r.reduce((a, x) => a + x.hit, 0) / r.length)}`);
}
