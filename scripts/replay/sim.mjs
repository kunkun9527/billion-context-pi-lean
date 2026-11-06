#!/usr/bin/env node
// Offline replay: rebuild each session's uncompressed context growth from provider usage,
// then re-run ACP's growth nudge with different nudgeGrowthTokens (G) and price the result.
// Usage: node sim.mjs [--traces FILE] [--g 50,70,100,130,150] [--set KEY=VALUE ...] [--scenarios]
// G values are in ACP-estimated tokens, the unit nudgeGrowthTokens uses.
import { parseArgs } from "node:util";
import { loadTraces, compressKind, quantile, DEFAULT_TRACES } from "./common.mjs";

const { values: A } = parseArgs({ options: {
  traces: { type: "string", default: DEFAULT_TRACES },
  g: { type: "string", default: "30,50,70,100,130,150" },
  set: { type: "string", multiple: true, default: [] },
  scenarios: { type: "boolean", default: false },
  boot: { type: "string", default: "1000" },
} });
const { sessions: S, args: X } = loadTraces(A.traces);
const MODEL = X?.model ?? "claude-opus-5-5";

// ---- measured from the traces ----
const comps = S.flatMap((s) => s.calls.filter((c) => c.compress && c.cres?.ok && c.cres.before > 0 && c.ctx > 0));
const K_MEASURED = quantile(comps.map((c) => c.ctx / c.cres.before), 0.5); // provider tokens per ACP token
function typicalGrowth() { // median per-call growth between ordinary calls
  const g = [];
  for (const s of S) { let prev = null; for (const c of s.calls) { if (c.ctx === 0) continue;
    if (prev && !prev.compress && c.ctx > prev.ctx) g.push(c.ctx - prev.ctx); prev = c; } }
  return quantile(g, 0.5);
}
function nudgeLag() { // calls from first nudge to the task compress
  const lags = [];
  for (const s of S) { let first = -1; s.calls.forEach((c, i) => {
    if (c.nudge && first < 0) first = i;
    if (c.compress) { if (compressKind(c) === "task" && first >= 0) lags.push(i - first); first = -1; }
  }); }
  return quantile(lags, 0.5);
}

const P0 = {
  BASE: 10_000, PRICE_CR: 0.2e-6, PRICE_IN: 4e-6, PRICE_OUT: 20e-6, // Opus list prices seen in usage.cost
  MS_PER_K_CTX: 9.8, MS_PER_K_UNC: 28.3, // OLS on per-call durationMs (correlational)
  K: K_MEASURED, SUM_RATIO: 0.043, SUM_K: 1.5, // summary = 4.3% of folded ACP tokens; ×SUM_K to provider tokens
  GEN_MS: 11_000, COMP_OUT: 800, TOOL_S0: 67, TOOL_S_PER_K: 0, // quality.mjs: task folds, tool time shows no size trend
  FOLD_FRAC: 0.75, PROTECT_CALLS: 3, USER_MSG: 3000, LAG: nudgeLag(), D0: typicalGrowth(),
  MIN_FLOOR: 20_000, FLOOR_RATIO: 0.45, PRESSURE: 0.4 * 872_000, MIN_PRESSURE: 30_000,
  LUNA_IN: 0, LUNA_OUT: 0,
};
for (const kv of A.set) { const [k, v] = kv.split("="); P0[k] = v === "Infinity" ? Infinity : +v; }

function runSession(calls, G, p) {
  const r = { cost: 0, timeMs: 0, compWaitMs: 0, task: 0, pressure: 0, forced: 0, foldedA: 0, ctxSum: 0, n: 0 };
  let chunks = []; // {tok (provider tokens), user: starts a user/idle turn}
  let summ = 0, ref = 0, prefix = null, prevCtx = 0, pendingAt = -1, first = true;
  let realFold = null; // a real compress call whose effect is applied at the next call: {kind, ctx}
  let carryUser = false;
  const ctxNow = () => p.BASE + summ + chunks.reduce((s, c) => s + c.tok, 0);
  const protectedSet = () => {
    const prot = new Set();
    for (let i = Math.max(0, chunks.length - p.PROTECT_CALLS); i < chunks.length; i++) prot.add(i);
    for (let i = chunks.length - 1; i >= 0; i--) if (chunks[i].user) { prot.add(i); break; }
    return prot;
  };
  const compressible = () => { const prot = protectedSet(); return chunks.reduce((s, c, i) => s + (prot.has(i) ? 0 : c.tok), 0); };
  let count = true; // false while replaying entries a forked session copied from its parent
  const fold = (amountReal, timed) => {
    const prot = protectedSet();
    let left = Math.min(amountReal, compressible()), tok = 0;
    if (left <= 0) return 0;
    const ctx = ctxNow();
    chunks.forEach((c, i) => { if (left > 0 && !prot.has(i)) { const t = Math.min(c.tok, left); c.tok -= t; left -= t; tok += t; } });
    const tokA = tok / p.K;
    const ms = p.GEN_MS + (p.TOOL_S0 + p.TOOL_S_PER_K * tokA / 1000) * 1000;
    if (count) {
      r.cost += ctx * p.PRICE_CR + p.COMP_OUT * p.PRICE_OUT + tokA * p.LUNA_IN + tokA * p.SUM_RATIO * p.LUNA_OUT;
      r.timeMs += timed ? ms : 0; r.compWaitMs += timed ? ms : 0; r.foldedA += tokA;
    }
    if (prefix === null) prefix = p.BASE + summ; // cache survives up to the oldest changed position
    summ += tokA * p.SUM_RATIO * p.SUM_K;
    ref = ctxNow();
    return tok;
  };
  for (const c0 of calls) {
    if (c0.ctx === 0) { carryUser ||= c0.user || c0.idle; continue; } // failed request: excluded everywhere
    const c = { ...c0, user: c0.user || c0.idle || carryUser }; carryUser = false;
    count = !c.dup;
    let d;
    const actWasComp = realFold !== null;
    if (first) d = c.ctx - p.BASE;
    else if (realFold) {
      // Real fold between the compress call and this call: reclaimed ≈ drop in provider ctx + one typical step.
      const reclaimed = Math.max(0, realFold.ctx - c.ctx + p.D0);
      if (realFold.kind !== "task" || G === "actual") { if (fold(reclaimed, realFold.kind !== "idle") && count) r.forced++; }
      d = p.D0;
    } else d = c.ctx - prevCtx;
    realFold = null;
    if (!first && !actWasComp && d < -20_000) { chunks = []; summ = 0; ref = 0; d = c.ctx - p.BASE; } // branch / tree jump
    else if (d < 0) { let left = -d; for (let i = chunks.length - 1; i >= 0 && left > 0; i--) { const t = Math.min(chunks[i].tok, left); chunks[i].tok -= t; left -= t; } d = 0; }
    first = false;
    // Only the user message itself is protected, not everything that arrived with it.
    if (c.user) { chunks.push({ tok: Math.max(0, d - p.USER_MSG) }); chunks.push({ tok: Math.min(d, p.USER_MSG), user: true }); }
    else chunks.push({ tok: d });
    prevCtx = c.ctx;
    if (c.compress) {
      if (c.cres?.ok) realFold = { kind: compressKind(c), ctx: c.ctx };
      continue; // the real compress call itself is replaced by the simulated fold cost
    }
    if (G !== "actual") {
      const ctx0 = ctxNow(), pendA = compressible() / p.K;
      const want = ctx0 >= p.PRESSURE ? (pendA >= p.MIN_PRESSURE ? "pressure" : null)
        : pendA >= G && ctx0 - ref >= Math.max(p.MIN_FLOOR, p.FLOOR_RATIO * G) ? "task" : null;
      if (want && pendingAt < 0) pendingAt = r.n;
      if (!want) pendingAt = -1;
      if (want && r.n - pendingAt >= p.LAG) { fold(compressible() * p.FOLD_FRAC, true); if (count) r[want]++; pendingAt = -1; }
    }
    const ctx = ctxNow();
    let unc;
    if (prefix !== null) { unc = Math.max(0, ctx - prefix); prefix = null; }
    else if (actWasComp) unc = Math.min(ctx, Math.max(1000, d)); // real call paid for a real fold the replay may not have
    else if (c.ctx > 30_000 && c.unc > 0.5 * c.ctx) unc = ctx * (c.unc / c.ctx); // natural cache miss (TTL etc.)
    else unc = Math.min(ctx, c.unc);
    if (!count) continue;
    if (c.model === MODEL) r.cost += (ctx - unc) * p.PRICE_CR + unc * p.PRICE_IN + c.out * p.PRICE_OUT;
    else r.cost += c.cost; // other models: keep their recorded cost
    const dur = c.dur ?? 0;
    r.timeMs += Math.max(0.2 * dur, dur + p.MS_PER_K_CTX * (ctx - c.ctx) / 1000 + p.MS_PER_K_UNC * (unc - c.unc) / 1000);
    r.ctxSum += ctx; r.n++;
  }
  return r;
}

function actualTotals() {
  const r = { cost: 0, timeMs: 0, compWaitMs: 0, task: 0, failedMs: 0, ctxSum: 0, n: 0 };
  for (const s of S) for (const c of s.calls) {
    if (c.dup) continue;
    if (c.ctx === 0) { r.failedMs += c.dur ?? 0; continue; }
    r.cost += c.cost;
    if (c.compress) {
      const k = compressKind(c);
      if (k === "task" && c.cres?.ok) r.task++;
      if (k !== "idle") { const w = (c.dur ?? 0) + (c.cres?.toolMs ?? 0); r.compWaitMs += w; r.timeMs += w; }
    } else { r.timeMs += c.dur ?? 0; r.ctxSum += c.ctx; r.n++; }
  }
  return r;
}

function sweep(p, Gs) {
  return Gs.map((G) => {
    const per = S.map((s) => runSession(s.calls, G, p));
    const t = per.reduce((a, r) => { for (const k in r) a[k] = (a[k] ?? 0) + r[k]; return a; }, {});
    return { G, per, ...t };
  });
}
const h = (ms) => (ms / 3.6e6).toFixed(2) + "h";
const label = (G) => (G === "actual" ? "actual-folds" : G / 1000 + "K");
function table(rows, base) {
  console.log("G | cost | Δcost | model+wait time | Δtime | compress wait | task folds | pressure folds | forced folds | mean ctx");
  for (const r of rows) console.log([label(r.G), "$" + r.cost.toFixed(0), (100 * r.cost / base.cost - 100).toFixed(1) + "%",
    h(r.timeMs), (100 * r.timeMs / base.timeMs - 100).toFixed(1) + "%", h(r.compWaitMs), r.task, r.pressure, r.forced,
    Math.round(r.ctxSum / r.n / 1000) + "K"].join(" | "));
}
// Session bootstrap for Δcost / Δtime of each G vs 100K.
function bootstrap(rows, base, n) {
  let seed = 12345; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (const r of rows) {
    if (r === base || r.G === "actual") continue;
    const dc = [], dt = [];
    for (let b = 0; b < n; b++) {
      let c1 = 0, c0 = 0, t1 = 0, t0 = 0;
      for (let i = 0; i < S.length; i++) { const j = Math.floor(rnd() * S.length); c1 += r.per[j].cost; c0 += base.per[j].cost; t1 += r.per[j].timeMs; t0 += base.per[j].timeMs; }
      dc.push(100 * c1 / c0 - 100); dt.push(100 * t1 / t0 - 100);
    }
    const cheaper = r.per.filter((x, i) => x.cost < base.per[i].cost - 0.01).length;
    const dearer = r.per.filter((x, i) => x.cost > base.per[i].cost + 0.01).length;
    console.log(`${label(r.G)} vs 100K: Δcost 90% CI [${quantile(dc, 0.05).toFixed(1)}%, ${quantile(dc, 0.95).toFixed(1)}%], `
      + `Δtime 90% CI [${quantile(dt, 0.05).toFixed(1)}%, ${quantile(dt, 0.95).toFixed(1)}%], sessions cheaper/dearer ${cheaper}/${dearer}`);
  }
}

const Gs = A.g.split(",").map((x) => (x === "actual" ? "actual" : +x * 1000));
if (!Gs.includes(100_000)) Gs.push(100_000);
const act = actualTotals();
console.log(`params: K=${P0.K.toFixed(2)} (measured), LAG=${P0.LAG} calls (measured), D0=${P0.D0} (measured), FOLD_FRAC=${P0.FOLD_FRAC}, PROTECT_CALLS=${P0.PROTECT_CALLS}`);
console.log(`ACTUAL (failed calls excluded, ${h(act.failedMs)} of them): cost $${act.cost.toFixed(0)}, model+wait ${h(act.timeMs)}, compress wait ${h(act.compWaitMs)}, task folds ${act.task}, mean ctx ${Math.round(act.ctxSum / act.n / 1000)}K`);
const scen = A.scenarios ? {
  base: {}, "SUM_RATIO=0.10": { SUM_RATIO: 0.10 }, "ctx slowdown ×2": { MS_PER_K_CTX: 19.6 }, "ctx slowdown ×0": { MS_PER_K_CTX: 0, MS_PER_K_UNC: 0 },
  "size-scaled compress time": { TOOL_S0: 37.7, TOOL_S_PER_K: 0.242 }, "compress 2× slower": { TOOL_S0: 134, GEN_MS: 22_000 }, "luna $1/$8": { LUNA_IN: 1e-6, LUNA_OUT: 8e-6 },
  "FOLD_FRAC=1": { FOLD_FRAC: 1 }, "FOLD_FRAC=0.5": { FOLD_FRAC: 0.5 }, "K=1.6": { K: 1.6 }, "K=2.2": { K: 2.2 },
  "PROTECT_CALLS=1": { PROTECT_CALLS: 1 }, "PROTECT_CALLS=6": { PROTECT_CALLS: 6 }, "LAG=5": { LAG: 5 },
} : { base: {} };
for (const [name, ov] of Object.entries(scen)) {
  const p = { ...P0, ...ov };
  const rows = sweep(p, ["actual", ...Gs]);
  const base = rows.find((r) => r.G === 100_000);
  console.log(`\n== ${name} ==`);
  table(rows, base);
  if (name === "base") bootstrap(rows, base, +A.boot);
}
