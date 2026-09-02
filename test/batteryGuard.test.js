import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logger } from '@gladysassistant/integration-sdk';
import { BatteryGuard, CAPTURE_POLICY } from '../src/tapo/batteryGuard.js';
import {
  BATTERY_THRESHOLDS,
  BATTERY_READING_MAX_AGE_MS,
  BATTERY_LOW_POLL_INTERVAL_MS,
  BATTERY_STOP_ALL_HYSTERESIS,
} from '../src/tapo/constants.js';

const ID = 'ext:ext-dev-tapo:camera:ID1';

test('a healthy battery allows everything', () => {
  const guard = new BatteryGuard();
  guard.update(ID, 91);
  assert.equal(guard.policyFor(ID), CAPTURE_POLICY.FULL);
  assert.equal(guard.allowsScheduled(ID), true);
  assert.equal(guard.allowsOnDemand(ID), true);
});

test('below the pause threshold, only explicit requests remain', () => {
  // The scheduled refresh is what drains the cell, so it goes first; opening the
  // widget or answering a doorbell still works.
  const guard = new BatteryGuard();
  guard.update(ID, BATTERY_THRESHOLDS.PAUSE_REFRESH - 1);
  assert.equal(guard.policyFor(ID), CAPTURE_POLICY.ON_DEMAND);
  assert.equal(guard.allowsScheduled(ID), false);
  assert.equal(guard.allowsOnDemand(ID), true);
});

test('below the stop threshold, nothing is captured at all', () => {
  const guard = new BatteryGuard();
  guard.update(ID, BATTERY_THRESHOLDS.STOP_ALL - 1);
  assert.equal(guard.policyFor(ID), CAPTURE_POLICY.NONE);
  assert.equal(guard.allowsScheduled(ID), false);
  assert.equal(guard.allowsOnDemand(ID), false);
});

test('a camera that went low stays held back until properly recharged', () => {
  // The point of the whole guard: resuming a few points above the threshold
  // would restart the drain on a still-weak reserve, and shallow cycles in the
  // low range wear the cell faster than one proper cycle.
  const guard = new BatteryGuard();
  guard.update(ID, 55); // drops below the pause threshold
  assert.equal(guard.allowsScheduled(ID), false);

  guard.update(ID, 65); // back above it, but not recharged
  assert.equal(guard.allowsScheduled(ID), false, 'must not resume on a partial charge');

  guard.update(ID, BATTERY_THRESHOLDS.RESUME - 1); // nearly there, still not enough
  assert.equal(guard.allowsScheduled(ID), false);

  guard.update(ID, BATTERY_THRESHOLDS.RESUME);
  assert.equal(guard.allowsScheduled(ID), true, 'reaching the resume level releases it');
});

test('the resume level is reachable by a solar camera', () => {
  // Regression: it used to require a FULL charge. A solar camera charges in
  // bursts and its level is sampled once a minute, so it essentially never read
  // 100% — a camera that dipped once stayed paused forever, and the only way out
  // was to disable the whole integration.
  assert.ok(
    BATTERY_THRESHOLDS.RESUME < 100,
    'requiring 100% makes the pause permanent in practice',
  );
  assert.ok(
    BATTERY_THRESHOLDS.RESUME > BATTERY_THRESHOLDS.PAUSE_REFRESH,
    'resuming at the pause level would restart the drain immediately',
  );
});

test('an unreachable resume level is warned about', () => {
  // The user's 85 sat under the old 90 limit and drew no comment, while the panel
  // peaked at 71 — the camera stopped capturing and nothing said why.
  const warnings = [];
  const original = logger.warn;
  logger.warn = (message) => warnings.push(message);
  try {
    const guard = new BatteryGuard();
    guard.configure({ battery_pause_refresh: 65, battery_stop_all: 50, battery_resume: 85 });
    assert.ok(
      warnings.some((message) => message.includes('85%')),
      'a resume a solar panel cannot reach must be called out',
    );
  } finally {
    logger.warn = original;
  }
});

test('the resume level can be set from the configuration', () => {
  const guard = new BatteryGuard();
  guard.configure({ battery_pause_refresh: 40, battery_stop_all: 20, battery_resume: 60 });
  guard.update(ID, 35);
  assert.equal(guard.allowsScheduled(ID), false);
  guard.update(ID, 55);
  assert.equal(guard.allowsScheduled(ID), false, 'below the configured resume level');
  guard.update(ID, 60);
  assert.equal(guard.allowsScheduled(ID), true);
});

test('a resume below the pause threshold is raised to it', () => {
  // Otherwise a camera would be released the moment it crossed back over the
  // pause limit, which is the shallow cycling the guard exists to prevent.
  const guard = new BatteryGuard();
  guard.configure({ battery_pause_refresh: 60, battery_resume: 30 });
  assert.ok(guard.resume >= guard.pauseRefresh);
});

test('no oscillation around the threshold', () => {
  // Without the hysteresis, a battery hovering at the threshold would start and
  // stop the refresh on every reading.
  const guard = new BatteryGuard();
  guard.update(ID, 59);
  for (const level of [61, 58, 62, 59, 63]) {
    guard.update(ID, level);
    assert.equal(guard.allowsScheduled(ID), false, `still paused at ${level}%`);
  }
});

test('a wired camera is never throttled', () => {
  // Wired cameras report no battery: they must not be guessed into a limit.
  const guard = new BatteryGuard();
  assert.equal(guard.policyFor('ext:ext-dev-tapo:camera:WIRED'), CAPTURE_POLICY.FULL);
  assert.equal(guard.allowsScheduled('ext:ext-dev-tapo:camera:WIRED'), true);
});

test('a battery camera that never reported is held to on-demand', () => {
  // Regression: an unknown level used to mean "capture freely", which is exactly
  // backwards. A battery camera that does not answer is more likely to be flat
  // than fine, and the scheduled refresh is what would finish it off.
  const guard = new BatteryGuard();
  guard.trackBatteryCamera(ID);
  assert.equal(guard.policyFor(ID), CAPTURE_POLICY.ON_DEMAND);
  assert.equal(guard.allowsScheduled(ID), false);
  assert.equal(guard.allowsOnDemand(ID), true, 'the user can still ask for an image');
});

test('reporting a level marks a camera as running on battery', () => {
  // Covers the models the prefix list does not know about yet.
  const guard = new BatteryGuard();
  guard.update(ID, 90);
  assert.equal(guard.isBatteryCamera(ID), true);
});

test('a stale reading stops authorizing captures', (t) => {
  // The guard decides from the LAST known level, so a camera whose readings stop
  // coming would keep being captured against an ever-staler number — while the
  // battery it reflects keeps dropping.
  t.mock.timers.enable({ apis: ['Date'] });
  const guard = new BatteryGuard();
  guard.update(ID, 95);
  assert.equal(guard.allowsScheduled(ID), true);

  t.mock.timers.tick(BATTERY_READING_MAX_AGE_MS + 1000);
  assert.equal(guard.allowsScheduled(ID), false, 'a stale 95% must not keep the refresh running');
  assert.equal(guard.allowsOnDemand(ID), true);
});

test('a fresh reading revives a camera whose level had gone stale', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const guard = new BatteryGuard();
  guard.update(ID, 95);
  t.mock.timers.tick(BATTERY_READING_MAX_AGE_MS + 1000);
  assert.equal(guard.allowsScheduled(ID), false);

  guard.update(ID, 92);
  assert.equal(guard.allowsScheduled(ID), true, 'the camera answered again');
});

test('an unreadable battery leaves the previous decision untouched', () => {
  // A failed read must not silently release a camera that was recovering.
  const guard = new BatteryGuard();
  guard.update(ID, 45);
  assert.equal(guard.allowsScheduled(ID), false);
  guard.update(ID, null);
  assert.equal(guard.allowsScheduled(ID), false);
  assert.equal(guard.levelOf(ID), 45);
});

test('each camera is tracked on its own', () => {
  const guard = new BatteryGuard();
  const other = 'ext:ext-dev-tapo:camera:ID2';
  guard.update(ID, 30);
  guard.update(other, 95);
  assert.equal(guard.allowsOnDemand(ID), false);
  assert.equal(guard.allowsScheduled(other), true);
});

test('the thresholds can be set from the configuration', () => {
  const guard = new BatteryGuard();
  guard.configure({ battery_pause_refresh: 80, battery_stop_all: 50 });
  guard.update(ID, 75);
  assert.equal(guard.allowsScheduled(ID), false, 'below the configured pause level');
  assert.equal(guard.allowsOnDemand(ID), true);
  guard.update(ID, 45);
  assert.equal(guard.allowsOnDemand(ID), false, 'below the configured stop level');
});

test('a stop threshold above the pause one is clamped', () => {
  // Otherwise the on-demand band would vanish and the two limits would conflict.
  const guard = new BatteryGuard();
  guard.configure({ battery_pause_refresh: 50, battery_stop_all: 90 });
  assert.ok(guard.stopAll <= guard.pauseRefresh);
});

test('a camera that cannot capture is cut off from the full poll', () => {
  // Blocking the captures was never enough on its own: the poll woke the camera
  // every round for three local calls, which drained a C610 that was already
  // forbidden from capturing anything.
  const guard = new BatteryGuard();
  guard.update(ID, BATTERY_THRESHOLDS.STOP_ALL - 1);
  assert.equal(guard.policyFor(ID), CAPTURE_POLICY.NONE);
  assert.equal(guard.allowsPolling(ID), false);

  // The on-demand band is throttled too. It used to poll at full pace, on the
  // grounds that it keeps its detections — but it produces no image until the
  // camera reaches `resume`, so those three calls a round buy nothing. Measured
  // on a solar C610 living in exactly that band: 3 points an hour, every capture
  // already paused.
  guard.update(ID, BATTERY_THRESHOLDS.PAUSE_REFRESH - 1);
  assert.equal(guard.policyFor(ID), CAPTURE_POLICY.ON_DEMAND);
  assert.equal(guard.allowsPolling(ID), false, 'no image to gain, so no wake-up to spend');

  // Above the pause threshold and released, the camera polls normally again.
  guard.update(ID, BATTERY_THRESHOLDS.RESUME);
  assert.equal(guard.policyFor(ID), CAPTURE_POLICY.FULL);
  assert.equal(guard.allowsPolling(ID), true);
});

test('the on-demand band still gets its spaced-out battery pulse', () => {
  // Throttling the poll must not cut the reading that lets the camera climb out:
  // a camera held by `recovering` reports its way back to `resume` and nothing
  // else would ever release it.
  const guard = new BatteryGuard();
  guard.update(ID, BATTERY_THRESHOLDS.PAUSE_REFRESH - 1);
  assert.equal(guard.allowsPolling(ID), false);
  assert.equal(guard.dueForLowPoll(ID), true, 'the pulse survives the throttling');

  // And it is what actually releases the camera.
  guard.polledAt.set(ID, Date.now() - BATTERY_LOW_POLL_INTERVAL_MS - 1);
  assert.equal(guard.dueForLowPoll(ID), true);
  guard.update(ID, BATTERY_THRESHOLDS.RESUME);
  assert.equal(guard.allowsPolling(ID), true, 'the pulse carried it back to full poll');
});

test('the battery pulse is spaced out, and never dropped entirely', () => {
  // The reading is what lets the guard release the camera once the panel has
  // refilled it: cut it as well and a camera that dipped could never report its
  // way out.
  const guard = new BatteryGuard();
  guard.update(ID, BATTERY_THRESHOLDS.STOP_ALL - 1);

  assert.equal(guard.dueForLowPoll(ID), true, 'the first pulse happens at once');
  assert.equal(guard.dueForLowPoll(ID), false, 'a second one is refused straight away');

  // Rewind the clock past the interval rather than waiting on it.
  guard.polledAt.set(ID, Date.now() - BATTERY_LOW_POLL_INTERVAL_MS - 1);
  assert.equal(guard.dueForLowPoll(ID), true, 'due again once the interval has passed');
});

test('the pulse interval leaves the reading fresh', () => {
  // The interval is derived from the max age, so this guards against someone
  // later writing a literal back in: two pulses must fit inside the freshness
  // window, or the level expires moments before its own refresh.
  assert.ok(
    BATTERY_LOW_POLL_INTERVAL_MS * 2 <= BATTERY_READING_MAX_AGE_MS,
    'a pulse must renew the level well before it expires',
  );

  // What the arithmetic is actually protecting: a camera pulsed on schedule
  // still has a level the guard trusts, so it never flips back to "unknown"
  // between two pulses.
  const guard = new BatteryGuard();
  guard.trackBatteryCamera(ID);
  guard.update(ID, BATTERY_THRESHOLDS.STOP_ALL - 1);

  // One full interval later, just before the next pulse is due.
  guard.readAt.set(ID, Date.now() - BATTERY_LOW_POLL_INTERVAL_MS);
  assert.notEqual(
    guard.freshLevel(ID),
    undefined,
    'the level must still be trusted when the next pulse comes round',
  );
});

test('a battery camera that never reports its level is throttled too', () => {
  // A battery camera whose readings stop coming — asleep, session refused,
  // network down — is the one `policyFor` already calls out as more likely to be
  // flat than fine. It answers ON_DEMAND there, protecting the captures while
  // leaving an explicit request possible, so keying the poll on NONE alone would
  // keep the full 20s round running against a camera of unknown charge.
  const guard = new BatteryGuard();
  guard.trackBatteryCamera(ID);

  assert.equal(guard.policyFor(ID), CAPTURE_POLICY.ON_DEMAND);
  assert.equal(guard.allowsOnDemand(ID), true, 'an explicit capture stays possible');
  assert.equal(guard.allowsPolling(ID), false, 'but it is not woken every round for it');

  // A level that has gone stale is the same case: the guard stops trusting it,
  // so the poll must back off with it.
  guard.update(ID, 95);
  assert.equal(guard.allowsPolling(ID), true);
  guard.readAt.set(ID, Date.now() - BATTERY_READING_MAX_AGE_MS - 1);
  assert.equal(guard.allowsPolling(ID), false, 'a stale level throttles the poll again');
});

test('a wired camera with no level is never throttled', () => {
  // Only battery models are protected: a wired camera has no battery feature to
  // report, and cutting its poll would cost it its detections for nothing.
  const guard = new BatteryGuard();
  assert.equal(guard.allowsPolling('ext:ext-dev-tapo:camera:WIRED'), true);
});

test('a resume raised above the requested value is reported', () => {
  // The Math.max is silent, so a resume below the pause level was corrected
  // without anyone knowing: the configured value and the effective one differed,
  // and nothing said which one was in force.
  const warnings = [];
  const original = logger.warn;
  logger.warn = (message) => warnings.push(message);
  try {
    new BatteryGuard({ pauseRefresh: 60, resume: 50 });
  } finally {
    logger.warn = original;
  }
  assert.ok(
    warnings.some((message) => message.includes('50%') && message.includes('60%')),
    'the correction names both the requested and the effective level',
  );
});

test('a resume a solar camera cannot reach is called out', () => {
  // The configuration that started this: pause 85, stop 80, resume 90 on a camera
  // whose history never read above 83. Once paused it could never be released —
  // and nothing reported it, the camera simply stopped capturing for good.
  const warnings = [];
  const original = logger.warn;
  logger.warn = (message) => warnings.push(message);
  try {
    new BatteryGuard({ pauseRefresh: 85, stopAll: 80, resume: 90 });
  } finally {
    logger.warn = original;
  }
  assert.ok(
    warnings.some((message) => message.includes('90%')),
    'a resume set that high is worth a warning',
  );
});

test('an ordinary resume is not warned about', () => {
  const warnings = [];
  const original = logger.warn;
  logger.warn = (message) => warnings.push(message);
  try {
    new BatteryGuard({ pauseRefresh: 40, stopAll: 25, resume: 55 });
  } finally {
    logger.warn = original;
  }
  assert.deepEqual(warnings, [], 'sane thresholds stay quiet');
});

test('a camera on the stop threshold does not flip regime on one point', () => {
  // Measured on a solar C610: throttled at 49% it stopped draining, the panel put
  // it back to 50%, the full poll resumed and 15 minutes later it read 49% again —
  // eight round trips in four hours, the camera pinned to the threshold by its own
  // polling. Crossing back must therefore take more than the single point that
  // dropped it.
  // Probed through `blocked` rather than `allowsPolling`: the whole band below
  // `pauseRefresh` is throttled now, so the poll no longer distinguishes the two
  // sides of `stopAll`. The block set is what the hysteresis actually guards.
  const guard = new BatteryGuard();
  guard.update(ID, BATTERY_THRESHOLDS.STOP_ALL - 1);
  assert.equal(guard.blocked.has(ID), true);
  assert.equal(guard.allowsPolling(ID), false);

  guard.update(ID, BATTERY_THRESHOLDS.STOP_ALL);
  assert.equal(guard.policyFor(ID), CAPTURE_POLICY.NONE, 'one point back is not a recovery');
  assert.equal(guard.blocked.has(ID), true, 'and the block stays on');

  // Clear of the band: the camera is genuinely climbing, so it is released — back
  // to ON_DEMAND, since it is still under the pause threshold.
  guard.update(ID, BATTERY_THRESHOLDS.STOP_ALL + BATTERY_STOP_ALL_HYSTERESIS);
  assert.equal(guard.blocked.has(ID), false);
  assert.equal(guard.policyFor(ID), CAPTURE_POLICY.ON_DEMAND);
});

test('a camera released by the hysteresis but still recovering is not polled at full pace', () => {
  // The reported case, with the user's own thresholds: stopAll 50, pause 65,
  // resume 85, on a panel that peaks at 71%. The camera is released by the
  // hysteresis at 55, so `blocked` is empty and the old `=== NONE` test let the
  // full poll run — while `recovering` held every capture until 85, a level that
  // panel never reaches. Full poll, no images, indefinitely.
  const guard = new BatteryGuard();
  guard.configure({ battery_pause_refresh: 65, battery_stop_all: 50, battery_resume: 85 });

  guard.update(ID, 49); // below stopAll: blocked
  assert.equal(guard.allowsPolling(ID), false);

  guard.update(ID, 71); // clear of the hysteresis band, but far below resume
  assert.equal(guard.blocked.has(ID), false, 'the hysteresis released it');
  assert.equal(guard.policyFor(ID), CAPTURE_POLICY.ON_DEMAND, 'but captures stay paused');
  assert.equal(guard.allowsPolling(ID), false, 'so the poll stays throttled with them');
});

test('a camera that never fell below the stop threshold is never held by the band', () => {
  // The hysteresis only holds cameras that actually dropped: one arriving inside
  // the band on its way DOWN must keep its normal poll, or every camera would be
  // throttled a few points early.
  const guard = new BatteryGuard();
  guard.update(ID, BATTERY_THRESHOLDS.STOP_ALL + 1);
  assert.equal(guard.blocked.has(ID), false, 'never dropped, so never held');
  assert.notEqual(guard.policyFor(ID), CAPTURE_POLICY.NONE);
});

test('lowering the stop threshold releases a camera it no longer covers', () => {
  // Lowering the setting is exactly how a user asks for such a camera to be let
  // go; nothing else would clear it until it climbed a band measured from the old
  // number.
  const guard = new BatteryGuard();
  guard.update(ID, 39);
  assert.equal(guard.blocked.has(ID), true);

  guard.configure({ battery_pause_refresh: 60, battery_stop_all: 20 });
  assert.equal(guard.blocked.has(ID), false, '39% is clear of a 20% limit');

  // Released by the block, but 39% is still under the 60% pause threshold, so the
  // camera stays on the throttled poll — the release is real, not a regression.
  assert.equal(guard.policyFor(ID), CAPTURE_POLICY.ON_DEMAND);
});
