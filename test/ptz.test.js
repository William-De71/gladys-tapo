import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatNumber, parsePtzSpaces, parsePresets, TapoPtz } from '../src/tapo/ptz.js';
import { CAMERA_MOVE } from '../src/tapo/constants.js';

// What a C200 answers `GetPresets` with, trimmed. Kept verbatim — the `tptz:`
// prefix, the token attribute and the nested Name element are exactly what a
// hand-written parser gets wrong.
const REAL_PRESETS = `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema">
<SOAP-ENV:Body><tptz:GetPresetsResponse>
<tptz:Preset token="1"><tt:Name>Entree</tt:Name><tt:PTZPosition><tt:PanTilt x="0.1" y="0.2"/></tt:PTZPosition></tptz:Preset>
<tptz:Preset token="2"><tt:Name>Jardin</tt:Name><tt:PTZPosition><tt:PanTilt x="-0.5" y="0"/></tt:PTZPosition></tptz:Preset>
</tptz:GetPresetsResponse></SOAP-ENV:Body></SOAP-ENV:Envelope>`;

test('the presets keep both the token and the name the user typed', () => {
  // The token is what ONVIF wants back, the name is what the dashboard shows.
  // Losing either one breaks a different half of the feature.
  const presets = parsePresets(REAL_PRESETS);
  assert.deepEqual(presets, [
    { token: '1', name: 'Entree' },
    { token: '2', name: 'Jardin' },
  ]);
});

test('a nameless preset is kept rather than dropped', () => {
  // Dropping it would silently renumber every preset after it, pointing the
  // dashboard options at the wrong positions.
  const xml = '<tptz:Preset token="7"></tptz:Preset>';
  assert.deepEqual(parsePresets(xml), [{ token: '7', name: '' }]);
});

test('a preset without a token is ignored', () => {
  // Nothing could be recalled with it, and an option pointing nowhere is worse
  // than a missing one.
  assert.deepEqual(parsePresets('<tptz:Preset><tt:Name>Ghost</tt:Name></tptz:Preset>'), []);
  assert.deepEqual(parsePresets(''), []);
  assert.deepEqual(parsePresets(undefined), []);
});

test('the declared spaces say what the camera can actually move', () => {
  const panTiltOnly = parsePtzSpaces(
    '<tt:ContinuousPanTiltVelocitySpace>http://...</tt:ContinuousPanTiltVelocitySpace>',
  );
  assert.equal(panTiltOnly.panTilt, true);
  // A camera without a motorized zoom answers a zoom command with a fault, so
  // absence has to read as "unsupported", never as "unknown, try anyway".
  assert.equal(panTiltOnly.zoom, false);

  const full = parsePtzSpaces(
    '<tt:ContinuousPanTiltVelocitySpace/><tt:ContinuousZoomVelocitySpace/><tt:TranslationSpace/>',
  );
  assert.equal(full.panTilt, true);
  assert.equal(full.zoom, true);
  assert.equal(full.relative, true);
});

test('the supported movements mirror the capabilities, and never list STOP', () => {
  const ptz = new TapoPtz('10.0.0.1', 'u', 'p');

  // Before discovery nothing is claimed: publishing movements a camera may not
  // have would render buttons that fault.
  assert.deepEqual(ptz.supportedMovements(), []);

  ptz.capabilities = { panTilt: true, zoom: false, relative: true };
  assert.deepEqual(ptz.supportedMovements(), [
    CAMERA_MOVE.PAN_LEFT,
    CAMERA_MOVE.PAN_RIGHT,
    CAMERA_MOVE.TILT_UP,
    CAMERA_MOVE.TILT_DOWN,
  ]);
  // The spec keeps STOP always supported and never listed as an option.
  assert.ok(!ptz.supportedMovements().includes(CAMERA_MOVE.STOP));

  ptz.capabilities = { panTilt: true, zoom: true, relative: true };
  assert.equal(ptz.supportedMovements().length, 6);
});

test('numbers are formatted as plain decimals, never exponential', () => {
  // A firmware rejects `1e-7` as unparseable rather than reading it as zero.
  assert.equal(formatNumber(-0.05), '-0.05');
  assert.equal(formatNumber(0.0000001), '0');
  assert.ok(!formatNumber(0.0000001).includes('e'));
  assert.equal(formatNumber(1), '1');
});

test('no command ever starts a movement that needs a later message to stop it', async () => {
  // The invariant the whole module rests on: every movement sent here ends on
  // its own. A ContinuousMove would need the spec's watchdog (A.2) to bound it,
  // so it must not be reintroduced without one — this is what would catch that.
  const ptz = new TapoPtz('10.0.0.1', 'u', 'p');
  ptz.serviceUrl = 'http://10.0.0.1:2020/onvif/service';
  ptz.profileToken = 'profile_1';

  const sent = [];
  ptz.call = async (url, body) => {
    sent.push(body);
    return '<ok/>';
  };

  await ptz.step(CAMERA_MOVE.PAN_LEFT);
  await ptz.gotoPreset('1');
  await ptz.stop();

  assert.ok(
    !sent.some((body) => body.includes('ContinuousMove')),
    'an unbounded move must never be sent without a watchdog to stop it',
  );
});

test('a step is bounded by construction and carries only the axis it moves', async () => {
  const ptz = new TapoPtz('10.0.0.1', 'u', 'p');
  ptz.serviceUrl = 'http://10.0.0.1:2020/onvif/service';
  ptz.profileToken = 'profile_1';

  const sent = [];
  ptz.call = async (url, body) => {
    sent.push(body);
    return '<ok/>';
  };

  await ptz.step(CAMERA_MOVE.TILT_UP);
  assert.ok(sent[0].includes('RelativeMove'));
  assert.ok(sent[0].includes('PanTilt'));
  // Tapo tilts the opposite way to the ONVIF convention: a positive `y` sends
  // the camera DOWN. Following the standard pointed both arrows the wrong way,
  // so the sign is asserted rather than left to the next reader to "fix".
  assert.ok(/y="-0?\.5"/.test(sent[0]), 'tilt up must send a negative y on Tapo');
  // Sending a zoom translation to a camera whose zoom is not being moved is
  // answered with a fault on some firmwares.
  assert.ok(!sent[0].includes('<tt:Zoom'));

  sent.length = 0;
  await ptz.step(CAMERA_MOVE.ZOOM_IN);
  assert.ok(sent[0].includes('<tt:Zoom'));
  assert.ok(!sent[0].includes('<tt:PanTilt'));
});

test('an unknown movement value is refused rather than guessed at', async () => {
  const ptz = new TapoPtz('10.0.0.1', 'u', 'p');
  ptz.serviceUrl = 'http://10.0.0.1:2020/onvif/service';
  ptz.profileToken = 'profile_1';
  ptz.call = async () => '<ok/>';

  // Moving a camera in a direction nobody asked for is worse than doing nothing.
  await assert.rejects(() => ptz.step(42), /PTZ_UNKNOWN_MOVEMENT/);
  await assert.rejects(() => ptz.step(99), /PTZ_UNKNOWN_MOVEMENT/);
});

test('stopping a camera that never moved costs no network call', async () => {
  const ptz = new TapoPtz('10.0.0.1', 'u', 'p');
  let called = false;
  ptz.call = async () => {
    called = true;
    return '<ok/>';
  };

  // Nothing was ever started through this client, so there is nothing to stop —
  // and discovering a service just to stop an idle camera would be a round trip
  // for nothing.
  await ptz.stop();
  assert.equal(called, false);
});

test('recalling a preset sends the token the camera handed out', async () => {
  const ptz = new TapoPtz('10.0.0.1', 'u', 'p');
  ptz.serviceUrl = 'http://10.0.0.1:2020/onvif/service';
  ptz.profileToken = 'profile_1';

  const sent = [];
  ptz.call = async (url, body) => {
    sent.push(body);
    return '<ok/>';
  };

  await ptz.gotoPreset('2');
  assert.ok(sent[0].includes('GotoPreset'));
  assert.ok(sent[0].includes('<tptz:PresetToken>2</tptz:PresetToken>'));
});

test('a preset token carrying XML characters is escaped', async () => {
  const ptz = new TapoPtz('10.0.0.1', 'u', 'p');
  ptz.serviceUrl = 'http://10.0.0.1:2020/onvif/service';
  ptz.profileToken = 'profile_1';

  let body = '';
  ptz.call = async (url, sentBody) => {
    body = sentBody;
    return '<ok/>';
  };

  // Tokens are free text on the camera side; an unescaped one produces an
  // envelope the camera answers with a parse fault.
  await ptz.gotoPreset('a&b');
  assert.ok(body.includes('a&amp;b'));
});
