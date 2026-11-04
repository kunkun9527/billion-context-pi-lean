import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createInitialState, type CompressionState } from "acp-kernel";
import { logError, logInfo, logWarn } from "./log.js";
import { SIDECAR_SCHEMA_VERSION, sidecarProducer } from "./contract.js";

export const STATE_SUFFIX = ".acp.json";

interface StateCacheSlot {
  state: CompressionState;
  activePack?: string;
}

function stateFileFor(sessionFile: string | undefined): string | null {
  if (sessionFile) return sessionFile + STATE_SUFFIX;
  return null;
}

export async function readParentSessionPath(sessionFile: string): Promise<string | undefined> {
  try {
    const handle = await fs.open(sessionFile, "r");
    try {
      const buf = Buffer.alloc(65536);
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      if (bytesRead === 0) return undefined;
      const firstLine = buf.subarray(0, bytesRead).toString("utf8").split("\n")[0] ?? "";
      if (!firstLine.startsWith("{")) return undefined;
      const header = JSON.parse(firstLine);
      return typeof header.parentSession === "string" ? header.parentSession : undefined;
    } finally {
      await handle.close();
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logWarn("state", { event: "read-parent-header-failed", file: sessionFile, error: e instanceof Error ? e.message : String(e) });
    }
    return undefined;
  }
}

function cacheKey(sessionFile: string | undefined, sessionId: string): string {
  return sessionFile ? `file:${sessionFile}` : `session:${sessionId}`;
}

export class SessionStateStore {
  private cache = new Map<string, StateCacheSlot>();
  private writes = new Map<string, Promise<void>>();
  private tmpSeq = 0;

  async load(sessionFile: string | undefined, sessionId: string): Promise<CompressionState> {
    const file = stateFileFor(sessionFile);
    const key = cacheKey(sessionFile, sessionId);
    const cached = this.cache.get(key);
    if (cached) return cached.state;
    let state = createInitialState();
    let activePack: string | undefined;
    if (file) {
      try {
        const raw = await fs.readFile(file, "utf8");
        const parsed = JSON.parse(raw) as CompressionState & { activePack?: unknown; schemaVersion?: unknown; producer?: unknown };
        // #368: an unknown NEWER schema means a future writer touched the
        // file. Best-effort read (same producer family), one warning — but we
        // never rewrite structures we do not understand beyond the v1 fields.
        if (typeof parsed.schemaVersion === "number" && parsed.schemaVersion > SIDECAR_SCHEMA_VERSION) {
          logWarn("state", { event: "schema-newer", file, schemaVersion: parsed.schemaVersion, known: SIDECAR_SCHEMA_VERSION });
        }
        if (parsed && Array.isArray(parsed.blocks)) {
          state = mergeInitialState(parsed);
          if (typeof parsed.activePack === "string" && parsed.activePack) activePack = parsed.activePack;
        }
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          logWarn("state", { event: "load-failed", file, error: e instanceof Error ? e.message : String(e) });
        }
      }
      // Inherit from parent when own state has no compression blocks.
      // Covers two cases: (1) ENOENT — file doesn't exist yet (new clone);
      // (2) empty blocks — file exists but was poisoned by a pre-fix resume
      // that saved createInitialState() before inheritance was added.
      if (state.blocks.length === 0 && !state.emergencyTruncateLatch?.length && sessionFile) {
        const parentState = await this.tryLoadParentState(sessionFile);
        if (parentState) state = parentState;
      }
    }
    this.cache.set(key, { state, activePack });
    return state;
  }

  /** Stamp the effective prompt pack for the live session (audit trail:
   *  persisted into the sidecar on the next save). */
  setActivePack(sessionFile: string | undefined, sessionId: string, activePack: string): void {
    const key = cacheKey(sessionFile, sessionId);
    const slot = this.cache.get(key);
    if (slot) this.cache.set(key, { ...slot, activePack });
  }

  getActivePack(sessionFile: string | undefined, sessionId: string): string | undefined {
    return this.cache.get(cacheKey(sessionFile, sessionId))?.activePack;
  }

  async save(state: CompressionState, sessionFile: string | undefined, sessionId: string): Promise<void> {
    const file = stateFileFor(sessionFile);
    const key = cacheKey(sessionFile, sessionId);
    const prev = this.cache.get(key);
    const activePack = prev?.activePack;
    // Cache update is unconditional: file-less (in-memory) sessions have no
    // sidecar to persist, but their state must still survive across turns in
    // this process — otherwise every compress result is dropped and the model
    // re-compresses the same original context forever (issue #322).
    this.cache.set(key, { state, activePack });
    if (!file) return;
    const dir = path.dirname(file);
    // #368 contract headers last: state fields can never clobber them.
    const payload: Record<string, unknown> = {
      ...state,
      schemaVersion: SIDECAR_SCHEMA_VERSION,
      producer: sidecarProducer(),
    };
    if (activePack) payload.activePack = activePack;
    // Snapshot and enqueue before any await, so the file reflects call order
    // rather than the order in which earlier awaits happened to resolve.
    const body = JSON.stringify(payload);
    // Lean: writes to one sidecar are serialized and each uses its own temp
    // file. A shared `.acp-tmp-<name>` let two overlapping saves rename the
    // same temp twice (ENOENT) or publish a half-written file.
    const prevWrite = this.writes.get(file) ?? Promise.resolve();
    const write = prevWrite.then(async () => {
      await fs.mkdir(dir, { recursive: true }).catch((e: unknown) => {
        logError("state", { event: "save-mkdir-failed", dir, error: e instanceof Error ? e.message : String(e) });
      });
      const tmp = path.join(dir, `.acp-tmp-${path.basename(file)}.${process.pid}.${++this.tmpSeq}`);
      try {
        await fs.writeFile(tmp, body, "utf8");
        await fs.rename(tmp, file);
      } catch (e) {
        logError("state", { event: "save-failed", file, error: e instanceof Error ? e.message : String(e) });
        await fs.rm(tmp, { force: true }).catch(() => undefined);
      }
    });
    this.writes.set(file, write);
    try {
      await write;
    } finally {
      if (this.writes.get(file) === write) this.writes.delete(file);
    }
  }

  invalidate(): void {
    this.cache.clear();
  }

  private async tryLoadParentState(sessionFile: string): Promise<CompressionState | undefined> {
    const MAX_CHAIN_DEPTH = 8;
    let current = sessionFile;
    for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth++) {
      const parentJsonl = await readParentSessionPath(current);
      if (!parentJsonl) return undefined;
      const parentAcp = stateFileFor(parentJsonl);
      if (!parentAcp) return undefined;
      try {
        const raw = await fs.readFile(parentAcp, "utf8");
        const parsed = JSON.parse(raw) as CompressionState;
        if (parsed && Array.isArray(parsed.blocks) && (parsed.blocks.length > 0 || readTruncationLatch(parsed.emergencyTruncateLatch).length > 0)) {
          logInfo("state", { event: "inherited-parent-state", file: parentAcp, depth, blocks: parsed.blocks.length, tokensCompressed: parsed.stats?.tokensCompressed ?? 0 });
          return mergeInitialState(parsed);
        }
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          logWarn("state", { event: "parent-state-load-failed", file: parentAcp, error: e instanceof Error ? e.message : String(e) });
          return undefined;
        }
      }
      current = parentJsonl;
    }
    logWarn("state", { event: "parent-chain-exhausted", file: sessionFile, maxDepth: MAX_CHAIN_DEPTH });
    return undefined;
  }
}

function readTruncationLatch(value: unknown): NonNullable<CompressionState["emergencyTruncateLatch"]> {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is NonNullable<CompressionState["emergencyTruncateLatch"]>[number] =>
    entry !== null && typeof entry === "object" && typeof entry.id === "string" &&
    typeof entry.fingerprint === "string" && /^[a-f0-9]{64}$/.test(entry.fingerprint) &&
    typeof entry.text === "string" && entry.text.includes("[truncated for context space]"),
  ).slice(-128);
}

function mergeInitialState(parsed: CompressionState): CompressionState {
  const fresh = createInitialState();
  return {
    blocks: parsed.blocks ?? fresh.blocks,
    messageRefs: parsed.messageRefs ?? fresh.messageRefs,
    tokenSnapshot: parsed.tokenSnapshot ?? fresh.tokenSnapshot,
    nudge: { ...fresh.nudge, ...(parsed.nudge ?? {}) },
    stats: { ...fresh.stats, ...(parsed.stats ?? {}) },
    absorbed: parsed.absorbed ?? fresh.absorbed,
    rules: parsed.rules ?? fresh.rules,
    nextRuleId: parsed.nextRuleId ?? fresh.nextRuleId,
    ...(parsed.terminalStreak !== undefined ? { terminalStreak: parsed.terminalStreak } : {}),
    emergencyTruncateLatch: readTruncationLatch(parsed.emergencyTruncateLatch),
    nextBlockId: parsed.nextBlockId ?? fresh.nextBlockId,
    nextRunId: parsed.nextRunId ?? fresh.nextRunId,
  };
}
