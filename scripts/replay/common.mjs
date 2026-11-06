import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_TRACES = path.join(os.tmpdir(), "acp-replay/traces.json");
export function loadTraces(file = DEFAULT_TRACES) {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  return { args: j.args, sessions: j.sessions };
}

// Why a compress call happened.
//   idle: inside an ACP idle-check turn
//   task: an ACP nudge was shown since the previous compress (policy-driven; replaced in replay)
//   user: the user's turn message explicitly asks to compress
//   self: none of the above (model-initiated); kept at its position like user/idle
const USER_ASK = /(先|帮我|请|可以|你可以)[^。？?\n]{0,6}(压缩|compact|compress)|(压缩|compact|compress)(一下|吧|了吧)|^\s*\/(compact|compress)/i;
export function compressKind(c) {
  if (c.turnIdle) return "idle";
  if (c.nudged) return "task";
  if (USER_ASK.test(c.turnUserText || "")) return "user";
  return "self";
}
export const quantile = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) * p)] : NaN; };
