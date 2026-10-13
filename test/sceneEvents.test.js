import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSceneEvents, DETECTION_KINDS } from '../src/sceneEvents.js';
import { detectionKind, parsePullMessages } from '../src/tapo/onvif.js';
import { detectionOf } from '../src/tapo/events.js';

const manifest = JSON.parse(
  readFileSync(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const camera = { external_id: 'ext:ext-tapo:camera:CAM1', name: 'Jardin' };

/**
 * A Gladys stand-in recording the scene events.
 * @returns {object} `{ events, publishSceneEvent }`.
 */
function recorder() {
  const events = [];
  return {
    events,
    publishSceneEvent: async (key, data) => {
      events.push({ key, data });
    },
  };
}

test('a detection fires one flat event with the declared variables only', async () => {
  const gladys = recorder();
  await createSceneEvents(gladys).detection(camera, 'person');
  assert.deepEqual(gladys.events, [
    { key: 'detection', data: { camera: camera.external_id, name: 'Jardin', kind: 'person' } },
  ]);
  const trigger = manifest.scene_triggers.find((entry) => entry.key === 'detection');
  assert.deepEqual(
    trigger.variables.map((variable) => variable.key).sort(),
    Object.keys(gladys.events[0].data).sort(),
  );
});

test('the kinds of the manifest are the kinds the code fires', () => {
  const trigger = manifest.scene_triggers.find((entry) => entry.key === 'detection');
  const kind = trigger.fields.find((field) => field.key === 'kind');
  assert.deepEqual(
    kind.options.map((option) => option.value),
    DETECTION_KINDS,
  );
});

test('a camera repeating its detection fires once per minute and kind', async () => {
  let now = 0;
  const gladys = recorder();
  const events = createSceneEvents(gladys, { now: () => now });
  await events.detection(camera, 'person');
  now = 30000;
  await events.detection(camera, 'person');
  await events.detection(camera, 'doorbell');
  now = 61000;
  await events.detection(camera, 'person');
  assert.deepEqual(
    gladys.events.map((event) => event.data.kind),
    ['person', 'doorbell', 'person'],
  );
});

test('the plain motion that comes with a person adds no second event', async () => {
  const gladys = recorder();
  const events = createSceneEvents(gladys, { now: () => 0 });
  await events.detection(camera, 'person');
  await events.detection(camera, 'motion');
  await events.detection({ ...camera, external_id: 'other' }, 'motion');
  assert.deepEqual(
    gladys.events.map((event) => `${event.data.camera}:${event.data.kind}`),
    [`${camera.external_id}:person`, 'other:motion'],
  );
});

test('an unknown kind and a refused event never throw', async () => {
  const gladys = {
    publishSceneEvent: async () => {
      throw new Error('429');
    },
  };
  const events = createSceneEvents(gladys);
  await events.detection(camera, 'alien');
  await events.detection(camera, 'motion');
});

test('ONVIF topics say what the camera saw', () => {
  assert.equal(detectionKind('tns1:RuleEngine/PeopleDetector/People'), 'person');
  assert.equal(
    detectionKind('tns1:RuleEngine/TPSmartEventDetector/TPSmartEvent/Vehicle'),
    'vehicle',
  );
  assert.equal(detectionKind('tns1:RuleEngine/PetDetector/Pet'), 'pet');
  assert.equal(detectionKind('tns1:RuleEngine/CellMotionDetector/Motion'), 'motion');
  const xml = `<wsnt:NotificationMessage><wsnt:Topic>tns1:RuleEngine/PeopleDetector/People</wsnt:Topic>
    <wsnt:Message><tt:Message UtcTime="2026-10-13T10:00:00Z"><tt:Data>
    <tt:SimpleItem Name="IsPeople" Value="true"/></tt:Data></tt:Message></wsnt:Message>
    </wsnt:NotificationMessage>`;
  const [event] = parsePullMessages(xml);
  assert.equal(event.kind, 'motion');
  assert.equal(event.detection, 'person');
});

test('polled events say what they saw when the firmware labels them', () => {
  assert.equal(detectionOf([{ eventType: 'person' }]), 'person');
  assert.equal(detectionOf([{ alarm_type: 2 }]), 'motion');
});
