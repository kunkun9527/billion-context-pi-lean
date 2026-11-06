#!/usr/bin/env node
// Quality proxies around real folds: decompress/search calls after a fold, and how often a
// file read that was just folded gets read again (same path + offset, file not edited since).
// Usage: node quality.mjs [--traces FILE] [--window 50]
import { parseArgs } from "node:util";
import { loadTraces, compressKind, quantile as q, DEFAULT_TRACES } from "./common.mjs";

const { values: A } = parseArgs({ options: {
  traces: { type: "string", default: DEFAULT_TRACES }, window: { type: "string", default: "50" },
} });
const W = +A.window;
const { sessions: S } = loadTraces(A.traces);
const key = (r) => r.p + "#" + (r.off ?? "") + "#" + (r.lim ?? "");
const sum = (a, fn) => a.reduce((s, x) => s + fn(x), 0);

const tot = { calls: 0, decomp: 0, search: 0, reads: 0 };
const folds = [];
for (const s of S) {
  const C = s.calls.filter((c) => c.ctx > 0);
  for (const c of C.filter((x) => !x.dup)) { tot.calls++; tot.decomp += c.decomp; tot.search += c.search; tot.reads += c.reads.length; }
  const everFolded = new Set(); // entry ids folded by any earlier fold
  for (let k = 0; k < C.length; k++) {
    const f = C[k];
    if (!f.compress || !f.cres?.ok || f.dup) continue;
    const now = new Set(f.cres.folded);
    const last = new Map(), lastEdit = new Map();
    for (let i = 0; i < k; i++) {
      for (const r of C[i].reads) last.set(key(r), { idx: i, id: C[i].id, p: r.p });
      for (const e of C[i].edits) lastEdit.set(e, i);
    }
    // Only reads still visible before this fold and not edited since; split by whether this fold hides them.
    const live = [...last.entries()].filter(([, v]) => !(lastEdit.get(v.p) > v.idx) && !everFolded.has(v.id));
    const res = {};
    for (const [g, arr] of [["fold", live.filter(([, v]) => now.has(v.id))], ["keep", live.filter(([, v]) => !now.has(v.id))]]) {
      let n = 0, rr = 0;
      for (const [kk, v] of arr) {
        n++;
        for (let j = k + 1; j < Math.min(C.length, k + 1 + W); j++) {
          if (C[j].edits.includes(v.p)) break;
          if (C[j].reads.some((r) => key(r) === kk)) { rr++; break; }
        }
      }
      res[g] = { n, rr };
    }
    for (const id of now) everFolded.add(id);
    let dec = 0, sea = 0;
    for (let j = k + 1; j < Math.min(C.length, k + 1 + W); j++) { dec += C[j].decomp; sea += C[j].search; }
    folds.push({ kind: compressKind(f), foldedTok: f.cres.before - f.cres.after, res, dec, sea,
      truncated: C.length - k - 1 < W, toolMs: f.cres.toolMs, genMs: f.dur, out: f.out });
  }
}
console.log("totals (non-failed calls)", tot);
function report(name, arr) {
  if (!arr.length) return;
  const fN = sum(arr, (x) => x.res.fold.n), fR = sum(arr, (x) => x.res.fold.rr);
  const kN = sum(arr, (x) => x.res.keep.n), kR = sum(arr, (x) => x.res.keep.rr);
  const pct = (a, b) => `${a}/${b}=${b ? (100 * a / b).toFixed(1) : "-"}%`;
  console.log(name.padEnd(14), "folds", String(arr.length).padStart(4),
    "| folded p50", Math.round(q(arr.map((x) => x.foldedTok), 0.5) / 1000) + "K(ACP)",
    "| re-read folded", pct(fR, fN), "| re-read kept", pct(kR, kN),
    "| rereads/fold", (fR / arr.length).toFixed(2),
    "| decomp/fold", (sum(arr, (x) => x.dec) / arr.length).toFixed(3),
    "| search/fold", (sum(arr, (x) => x.sea) / arr.length).toFixed(3),
    "| tail-truncated", arr.filter((x) => x.truncated).length);
}
report("all", folds);
for (const k of ["task", "idle", "user", "self"]) report(k, folds.filter((x) => x.kind === k));
const task = folds.filter((x) => x.kind === "task");
for (const [lo, hi] of [[0, 50e3], [50e3, 80e3], [80e3, 110e3], [110e3, 1e9]])
  report(`task ${lo / 1e3}-${hi < 1e9 ? hi / 1e3 : "+"}K`, task.filter((x) => x.foldedTok >= lo && x.foldedTok < hi));
const pts = task.filter((x) => x.toolMs > 0 && x.toolMs < 600e3);
if (pts.length > 2) {
  const n = pts.length, mx = sum(pts, (x) => x.foldedTok / 1e3) / n, my = sum(pts, (x) => x.toolMs / 1e3) / n;
  const b = sum(pts, (x) => (x.foldedTok / 1e3 - mx) * (x.toolMs / 1e3 - my)) / sum(pts, (x) => (x.foldedTok / 1e3 - mx) ** 2);
  console.log(`task compress tool time (s) ≈ ${(my - b * mx).toFixed(1)} + ${b.toFixed(3)}·foldedK_ACP  (n=${n}, mean ${my.toFixed(1)}s)`);
}
console.log("task compress: gen ms p50", q(task.map((x) => x.genMs ?? 0), 0.5), "| out p50", q(task.map((x) => x.out), 0.5));
console.log("Note: windows overlap between nearby folds; bash/cat reads are not counted.");
