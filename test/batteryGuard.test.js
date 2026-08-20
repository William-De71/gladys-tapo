import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BatteryGuard, CAPTURE_POLICY } from '../src/tapo/batteryGuard.js';
import {
  BATTERY_THRESHOLDS,
  BATTERY_READING_MAX_AGE_MS,
  BATTERY_LOW_POLL_INTERVAL_MS,
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

test('a camera too low to capture is also cut off from the full poll', () => {
  // Blocking the captures was never enough on its own: the poll woke the camera
  // every round for three local calls, which drained a C610 that was already
  // forbidden from capturing anything.
  const guard = new BatteryGuard();
  guard.update(ID, BATTERY_THRESHOLDS.STOP_ALL - 1);
  assert.equal(guard.policyFor(ID), CAPTURE_POLICY.NONE);
  assert.equal(guard.allowsPolling(ID), false);

  // Everything above that band still polls normally: the on-demand band keeps
  // its detections, it is only the captures that stop there.
  guard.update(ID, BATTERY_THRESHOLDS.PAUSE_REFRESH - 1);
  assert.equal(guard.policyFor(ID), CAPTURE_POLICY.ON_DEMAND);
  assert.equal(guard.allowsPolling(ID), true);
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
  // Two pulses must fit inside the freshness window: at exactly the max age the
  // level would expire moments before its own refresh, flipping the camera
  // between "known" and "stale" for nothing.
  assert.ok(
    BATTERY_LOW_POLL_INTERVAL_MS * 2 <= BATTERY_READING_MAX_AGE_MS,
    'a pulse must renew the level well before it expires',
  );
});
