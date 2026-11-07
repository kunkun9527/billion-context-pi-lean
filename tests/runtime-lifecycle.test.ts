import { test } from "node:test";
import assert from "node:assert/strict";
import { createRuntime, MAX_COMPRESS_ATTEMPTS } from "../src/runtime.js";

function populate(runtime: ReturnType<typeof createRuntime>, sid: string) {
  runtime.markNudgeShown(sid, "turn", 1234);
  runtime.markNudgeRecorded(sid, "turn");
  runtime.noteCompressOutcomes(sid, "turn", Array.from({ length: MAX_COMPRESS_ATTEMPTS }, (_, i) => ({ toolCallId: String(i), isError: true, success: false })));
  runtime.noteHostUsage(sid, 1000);
  runtime.noteHostUsage(sid, 1000);
  runtime.noteSizeDivergence(sid, true);
  runtime.noteSizeDivergence(sid, true);
  runtime.noteTerminalEscape(sid, true);
  runtime.noteTruncationSkipped(sid, true);
  runtime.noteLatestUserOverLimit(sid, true);
  runtime.noteDegenerationNotice(sid, "100:x");
  runtime.noteTokenScale(sid, true);
  runtime.noteDeadCompress(sid, "range");
  runtime.setLastSentMessages(sid, []);
  runtime.noteSentViewCount(sid, { viewTokens: 100, rawTokens: 200, blockSig: "0|", history: { count: 0, firstId: null, lastId: null }, limit: 1000, usable: true });
  const overflow = runtime.overflowFor(sid);
  overflow.armed = true;
  overflow.setLearnedWindow("small", 130_000);
  const throttle = runtime.throttleFor(sid);
  throttle.onThrottleError(5);
  const sleeper = throttle.sleepController();
  return { overflow, throttle, sleeper };
}

function assertTurnTrackingReset(runtime: ReturnType<typeof createRuntime>, sid: string) {
  assert.equal(runtime.nudgeShownFor(sid, "turn"), false);
  assert.equal(runtime.nudgeRecordedFor(sid, "turn"), false);
  assert.equal(runtime.nudgeShownTokensFor(sid, "turn"), undefined);
  assert.equal(runtime.compressRetryCappedFor(sid, "turn"), false);
  assert.equal(runtime.peekSentViewCount(sid), undefined);
  assert.equal(runtime.noteHostUsage(sid, 1000), false, "usage calibration window starts over");
  assert.equal(runtime.noteSizeDivergence(sid, true), false, "divergence streak starts over");
  assert.equal(runtime.noteTerminalEscape(sid, true), true);
  assert.equal(runtime.noteTruncationSkipped(sid, true), true);
  assert.equal(runtime.noteLatestUserOverLimit(sid, true), true);
  assert.equal(runtime.noteDegenerationNotice(sid, "100:x"), true);
}

test("startup resets turn-local tracking and aborts throttle sleep without forgetting overflow", () => {
  const runtime = createRuntime({});
  const { overflow, throttle, sleeper } = populate(runtime, "start");
  runtime.startSession("start");
  assertTurnTrackingReset(runtime, "start");
  assert.equal(runtime.overflowFor("start"), overflow);
  assert.equal(overflow.armed, true);
  assert.equal(overflow.learnedWindowFor("small"), 130_000);
  assert.deepEqual(runtime.getLastSentMessages("start"), [], "startup must not drop the captured session-summary prefix");
  assert.equal(runtime.noteTokenScale("start", true), false, "startup preserves the existing token-scale episode");
  assert.equal(runtime.throttleFor("start"), throttle);
  assert.equal(throttle.state.attempts, 0);
  assert.equal(sleeper.signal.aborted, true);
  assert.equal(runtime.noteDeadCompress("start", "range"), 2, "startup is not a compression-progress reset");
});

test("shutdown releases only the target session and is safe to repeat", () => {
  const runtime = createRuntime({});
  const released = populate(runtime, "released");
  const other = populate(runtime, "other");
  runtime.releaseSession("released");
  runtime.releaseSession("released");
  assertTurnTrackingReset(runtime, "released");
  assert.equal(released.sleeper.signal.aborted, true);
  assert.notEqual(runtime.overflowFor("released"), released.overflow);
  assert.notEqual(runtime.throttleFor("released"), released.throttle);
  assert.equal(runtime.getLastSentMessages("released"), null);
  assert.equal(runtime.noteDeadCompress("released", "range"), 1);
  assert.equal(runtime.noteTokenScale("released", false), false);
  assert.equal(runtime.overflowFor("other"), other.overflow);
  assert.equal(runtime.throttleFor("other"), other.throttle);
  assert.equal(other.sleeper.signal.aborted, false);
  assert.equal(runtime.nudgeShownFor("other", "turn"), true);
  assert.equal(runtime.noteDegenerationNotice("other", "100:x"), false);
  assert.equal(runtime.noteLatestUserOverLimit("other", true), false);
  runtime.releaseSession("other");
});

test("startup invalidates cached sidecars, but shutdown is not a saved-state reset", async () => {
  const runtime = createRuntime({});
  const saved = await runtime.store.load(undefined, "persisted");
  saved.stats.tokensCompressed = 1234;
  await runtime.store.save(saved, undefined, "persisted");
  runtime.releaseSession("persisted");
  assert.equal((await runtime.store.load(undefined, "persisted")).stats.tokensCompressed, 1234);
  runtime.startSession("persisted");
  assert.equal((await runtime.store.load(undefined, "persisted")).stats.tokensCompressed, 0, "baseline startup invalidates the store; release must not replace that policy");
});

test("shutdown does not bypass an in-flight session lock", async () => {
  const runtime = createRuntime({});
  const first = await runtime.acquireLock("locked");
  runtime.releaseSession("locked");
  let acquired = false;
  const second = runtime.acquireLock("locked").then((release) => { acquired = true; return release; });
  await Promise.resolve();
  assert.equal(acquired, false);
  first();
  (await second)();
});
