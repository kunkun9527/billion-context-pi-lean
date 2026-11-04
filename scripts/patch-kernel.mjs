// Source checkouts only: npm releases ship the already-patched bundled dist.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const files = [
  ["index.js", "543a2728bce0d4791d2936db37b92a20d2659765aa23cf10195d4133250b8b40", "7044136ccbcd3bb040f32905a859d2c3b671c6c0dd5b827387a5325acf8b10fe"],
  ["types.d.ts", "46767e0503665d5bb9e4646983c8eb71490ec2cd23902f3e1a3c801328e369ce", "4852098cf090e1ebcfa6213ba1142c9b3b79d7d8c9ea62c28492dd96b4aa7299"],
];
const hashes = files.map(([name]) => createHash("sha256").update(readFileSync(new URL(`../node_modules/acp-kernel/dist/${name}`, import.meta.url))).digest("hex"));
if (files.every(([, , patched], i) => hashes[i] === patched)) process.exit(0);
if (!files.every(([, original], i) => hashes[i] === original)) {
  throw new Error("Unexpected acp-kernel files; reinstall the locked dependencies before applying the Lean patch.");
}
const patch = fileURLToPath(new URL("../patches/acp-kernel-0.0.101.patch", import.meta.url));
execFileSync("git", ["apply", "--check", patch], { cwd: root, stdio: "inherit" });
execFileSync("git", ["apply", patch], { cwd: root, stdio: "inherit" });
for (const [name, , expected] of files) {
  const actual = createHash("sha256").update(readFileSync(new URL(`../node_modules/acp-kernel/dist/${name}`, import.meta.url))).digest("hex");
  if (actual !== expected) throw new Error(`Patched acp-kernel/${name} did not match the reviewed hash.`);
}
