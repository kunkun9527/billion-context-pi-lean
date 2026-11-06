#!/usr/bin/env node
// Extract per-call traces from Pi session JSONL files (read-only on the sessions).
// Usage: node extract.mjs [--sessions DIR] [--since YYYY-MM-DD] [--model ID] [--out FILE]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values: A } = parseArgs({ options: {
  sessions: { type: "string", default: path.join(os.homedir(), ".pi/agent/sessions") },
  since: { type: "string", default: "2026-10-07" },
  model: { type: "string", default: "claude-opus-5-5" },
  "min-share": { type: "string", default: "0.8" },
  out: { type: "string", default: path.join(os.tmpdir(), "acp-replay/traces.json") },
} });
const ROOT = A.sessions;

// Top-level session files only: <project>/<timestamp>_<id>.jsonl. Subagent runs live in
// <project>/<session>/<id>/run-N/ and are skipped.
function listSessions() {
  const out = [];
  for (const proj of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    const dir = path.join(ROOT, proj.name);
    for (const f of fs.readdirSync(dir, { withFileTypes: true }))
      if (f.isFile() && f.name.endsWith(".jsonl") && f.name.slice(0, 10) >= A.since) out.push(path.join(dir, f.name));
  }
  return out.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

const norm = (p, cwd) => {
  if (!p || typeof p !== "string") return null;
  let s = p.replace(/\\/g, "/").replace(/^~\//, os.homedir().replace(/\\/g, "/") + "/");
  if (!/^[a-zA-Z]:\//.test(s) && !s.startsWith("/")) s = (cwd || "").replace(/\\/g, "/") + "/" + s.replace(/^\.\//, "");
  return s.replace(/^\/([a-z])\//i, "$1:/").toLowerCase();
};
const EDIT_TOOLS = new Set(["edit", "write", "replace", "insert", "replace_match"]);

function toolsOf(call, cwd, out) {
  const n = call.name, a = call.arguments || {};
  if (n === "read") { const p = norm(a.path, cwd); if (p) out.reads.push({ p, off: a.offset ?? null, lim: a.limit ?? null }); }
  else if (EDIT_TOOLS.has(n)) { const p = norm(a.path, cwd); if (p) out.edits.push(p); }
  else if (n === "compress") out.compress = true;
  else if (n === "decompress" || (n === "acp_context" && a.op === "decompress")) out.decomp++;
  else if ((n === "acp_context" && a.op === "search_context") || n === "recall") out.search++;
  else if (n === "codemode" && typeof a.code === "string") {
    // Best effort: literal paths only.
    for (const m of a.code.matchAll(/tools\.read\(\{\s*path:\s*["'`]([^"'`]+)["'`]([^}]*)\}/g)) {
      const p = norm(m[1], cwd);
      const off = m[2].match(/offset:\s*(\d+)/), lim = m[2].match(/limit:\s*(\d+)/);
      if (p) out.reads.push({ p, off: off ? +off[1] : null, lim: lim ? +lim[1] : null, cm: true });
    }
    for (const m of a.code.matchAll(/tools\.(?:edit|write)\(\{\s*path:\s*["'`]([^"'`]+)/g)) { const p = norm(m[1], cwd); if (p) out.edits.push(p); }
    for (const _ of a.code.matchAll(/acp_context\(\{\s*op:\s*["'`]decompress/g)) out.decomp++;
  }
}

const files = listSessions();
const sessions = [];
const seenIds = new Set(); // forked sessions repeat their parent's entries
for (const f of files) {
  let lines;
  try { lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { continue; }
  if (lines[0]?.type !== "session") continue;
  const cwd = lines[0].cwd;
  let side = null;
  try { side = JSON.parse(fs.readFileSync(f + ".acp.json", "utf8")); } catch {}
  const foldedByCall = new Map();
  for (const b of side?.blocks ?? []) if (b.compressCallId) {
    const s = foldedByCall.get(b.compressCallId) ?? new Set();
    for (const id of b.directMessageIds ?? b.effectiveMessageIds ?? []) s.add(id);
    foldedByCall.set(b.compressCallId, s);
  }
  const calls = [], callById = new Map();
  let userStart = false, idleStart = false, turn = 0, turnIdle = false, turnUserText = "";
  let nudgeNext = false, nudgedSinceComp = false;
  for (const e of lines) {
    if (e.type === "custom" && e.customType === "acp-nudge") { nudgeNext = true; nudgedSinceComp = true; continue; }
    if (e.type === "custom_message" && e.customType === "acp-idle-check") { idleStart = true; turn++; turnIdle = true; turnUserText = ""; continue; }
    if (e.type !== "message") continue;
    const m = e.message;
    if (m.role === "user") {
      userStart = true; turn++; turnIdle = false;
      turnUserText = (typeof m.content === "string" ? m.content : (m.content || []).filter((c) => c.type === "text").map((c) => c.text).join(" ")).slice(0, 300);
      continue;
    }
    if (m.role === "assistant" && m.usage) {
      const u = m.usage;
      const c = {
        id: e.id, t: Date.parse(e.timestamp), model: m.model,
        ctx: (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0),
        unc: (u.input || 0) + (u.cacheWrite || 0), out: u.output || 0,
        dur: m.durationMs ?? null, cost: u.cost?.total ?? 0,
        user: userStart, idle: idleStart, turn, turnIdle, turnUserText: userStart || idleStart ? turnUserText : undefined,
        reads: [], edits: [], decomp: 0, search: 0, compress: false,
      };
      for (const part of m.content || []) if (part.type === "toolCall") {
        toolsOf(part, cwd, c);
        if (part.name === "compress") { c.compressCallId = part.id; callById.set(part.id, c); }
      }
      if (seenIds.has(e.id)) c.dup = true; else seenIds.add(e.id);
      if (nudgeNext) c.nudge = true;
      if (c.compress) { c.turnUserText = turnUserText; c.nudged = nudgedSinceComp; nudgedSinceComp = false; }
      userStart = idleStart = nudgeNext = false;
      calls.push(c);
      continue;
    }
    if (m.role === "toolResult" && m.toolName === "compress") {
      const c = callById.get(m.toolCallId);
      if (!c) continue;
      const txt = (m.content || []).map((x) => x.text || "").join(" ");
      const mm = txt.match(/([\d.]+)K → ([\d.]+)K tokens/);
      c.cres = { ok: !!mm, toolMs: Date.parse(e.timestamp) - c.t,
        before: mm ? +mm[1] * 1000 : null, after: mm ? +mm[2] * 1000 : null,
        folded: [...(foldedByCall.get(m.toolCallId) ?? [])] };
    }
  }
  const share = calls.filter((c) => c.model === A.model).length / Math.max(1, calls.length);
  if (calls.length < 5 || share < +A["min-share"]) continue;
  sessions.push({ file: path.basename(f), cwd, calls });
}
fs.mkdirSync(path.dirname(A.out), { recursive: true });
fs.writeFileSync(A.out, JSON.stringify({ args: A, sessions }));
const all = sessions.flatMap((s) => s.calls);
console.log({ files: files.length, sessions: sessions.length, calls: all.length,
  duplicated: all.filter((c) => c.dup).length, nonTargetModel: all.filter((c) => c.model !== A.model).length, failed: all.filter((c) => c.ctx === 0).length,
  compress: all.filter((c) => c.compress).length, out: A.out });
