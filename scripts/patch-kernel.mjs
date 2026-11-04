// Source checkouts only: npm releases ship the already-patched bundled dist.
// Applies patches/acp-kernel-0.0.101.patch with jsdiff (no git or patch binary needed,
// tolerant of CRLF checkouts) and only writes files whose result matches the reviewed hash.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { applyPatch, parsePatch } from "diff";

const KERNEL = "node_modules/acp-kernel/dist/";
// [file, sha256 of the pristine acp-kernel@0.0.101 file, sha256 after the Lean patch]
const files = [
  ["index.js", "543a2728bce0d4791d2936db37b92a20d2659765aa23cf10195d4133250b8b40", "3a24cd1ecd1bb8c6b8add0916418d6eeaf7b21f81992eeeccecd8d8e92193cdc"],
  ["types.d.ts", "46767e0503665d5bb9e4646983c8eb71490ec2cd23902f3e1a3c801328e369ce", "4852098cf090e1ebcfa6213ba1142c9b3b79d7d8c9ea62c28492dd96b4aa7299"],
  ["cache-report.d.ts", "3a012d53ec810be8bfdb816dd698cf91a1ff28a26afeba670feaad41749ee3b8", "40c0db633855b95ead66a8a705808ab093997e036640bf9a5ac520dfe4cc5599"],
];

const sha = (text) => createHash("sha256").update(text).digest("hex");
const urlOf = (name) => new URL(`../${KERNEL}${name}`, import.meta.url);
const current = files.map(([name]) => readFileSync(urlOf(name), "utf8"));
const hashes = current.map(sha);
if (files.every(([, , patched], i) => hashes[i] === patched)) process.exit(0);
if (!files.every(([, original], i) => hashes[i] === original)) {
  throw new Error("Unexpected acp-kernel files; reinstall the locked dependencies (npm ci) before applying the Lean patch.");
}

const patchText = readFileSync(new URL("../patches/acp-kernel-0.0.101.patch", import.meta.url), "utf8");
const byFile = new Map(parsePatch(patchText).map((p) => [p.newFileName.replace(/^b\//, ""), p]));
const results = files.map(([name, , expected], i) => {
  const filePatch = byFile.get(KERNEL + name);
  if (!filePatch) throw new Error(`Lean patch has no hunk for acp-kernel/${name}.`);
  const out = applyPatch(current[i], filePatch);
  if (out === false) throw new Error(`Lean patch does not apply to acp-kernel/${name}.`);
  if (sha(out) !== expected) throw new Error(`Patched acp-kernel/${name} did not match the reviewed hash.`);
  return out;
});
if (byFile.size !== files.length) throw new Error("Lean patch touches files the script does not verify.");
files.forEach(([name], i) => writeFileSync(urlOf(name), results[i]));
