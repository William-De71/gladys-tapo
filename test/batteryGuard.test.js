import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BatteryGuard, CAPTURE_POLICY } from '../src/tapo/batteryGuard.js';
import { BATTERY_THRESHOLDS } from '../src/tapo/constants.js';

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

test('a camera that went low stays held back until FULLY charged', () => {
  // The point of the whole guard: resuming a few points above the threshold
  // would restart the drain on a still-weak reserve, and shallow cycles in the
  // low range wear the cell faster than one proper cycle.
  const guard = new BatteryGuard();
  guard.update(ID, 55); // drops below the pause threshold
  assert.equal(guard.allowsScheduled(ID), false);

  guard.update(ID, 65); // back above it, but not charged
  assert.equal(guard.allowsScheduled(ID), false, 'must not resume on a partial charge');

  guard.update(ID, 99); // nearly there, still not enough
  assert.equal(guard.allowsScheduled(ID), false);

  guard.update(ID, BATTERY_THRESHOLDS.RESUME);
  assert.equal(guard.allowsScheduled(ID), true, 'a full charge releases it');
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

test('a camera with no battery reading is never throttled', () => {
  // Wired cameras report no battery: they must not be guessed into a limit.
  const guard = new BatteryGuard();
  assert.equal(guard.policyFor('ext:ext-dev-tapo:camera:WIRED'), CAPTURE_POLICY.FULL);
  assert.equal(guard.allowsScheduled('ext:ext-dev-tapo:camera:WIRED'), true);
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
