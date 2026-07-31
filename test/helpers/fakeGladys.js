// Minimal stand-in for the Gladys SDK instance, exposing only what the modules
// under test call. Keeping it tiny is deliberate: a fake that mirrors the whole
// SDK would pass even when the real contract changed.

/**
 * Build a fake Gladys SDK instance.
 * @param {object} [options] - Options.
 * @param {string} [options.selector] - The integration selector.
 * @param {Array} [options.devices] - The devices the user "created".
 * @returns {object} The fake instance, with a `published` log for assertions.
 * @example
 * const gladys = fakeGladys({ devices: [device] });
 */
export function fakeGladys({ selector = 'ext-dev-tapo', devices = [], scanResults } = {}) {
  const published = { states: [], devices: [], images: [] };

  return {
    selector,
    devices,
    published,
    // Mirrors the SDK contract exactly: Gladys rejects any external id that does
    // not start with `ext:<selector>:`.
    externalId: (suffix) => `ext:${selector}:${suffix}`,
    externalIds: (type, platformId) => {
      const device = `ext:${selector}:${type}:${platformId}`;
      return { device, feature: (key) => `${device}:${key}` };
    },
    scanNetwork: async () => {
      if (scanResults instanceof Error) {
        throw scanResults;
      }
      return scanResults || [];
    },
    publishState: async (featureExternalId, value) => {
      published.states.push({ featureExternalId, value });
    },
    publishStates: async (states) => {
      published.states.push(...states);
    },
    publishDiscoveredDevices: async (list) => {
      published.devices = list;
    },
    publishCameraImage: async (deviceExternalId, image) => {
      published.images.push({ deviceExternalId, image });
    },
    getDevices: async () => devices,
  };
}

/**
 * Build a fake cloud client returning canned event payloads.
 * @param {object} [options] - Options.
 * @param {Array} [options.events] - The events the cloud reports.
 * @param {number|null} [options.battery] - The battery level it reports.
 * @returns {object} The fake client, with a `calls` counter.
 * @example
 * const cloud = fakeCloud({ events: [{ eventType: 'ring', timestamp: 1 }] });
 */
export function fakeCloud({ events = [], battery = null } = {}) {
  const state = { calls: 0 };
  return {
    calls: state,
    authenticatedRequest: async () => {
      state.calls += 1;
      const responses = [{ result: { system: { event_list: events } } }];
      if (battery !== null) {
        responses.push({ result: { battery: { usage: { percent: battery } } } });
      }
      return { responseData: JSON.stringify({ result: { responses } }) };
    },
  };
}

/**
 * Build a fake local API client, standing in for one camera.
 * @param {object} [options] - What the camera reports.
 * @param {Array} [options.events] - The detections it returns.
 * @param {number|null} [options.battery] - Its battery level.
 * @returns {object} The fake client.
 * @example
 * const api = fakeLocalApi({ battery: 91 });
 */
export function fakeLocalApi({ events = [], battery = null } = {}) {
  const calls = { count: 0 };
  return {
    calls,
    getBatteryLevel: async () => {
      calls.count += 1;
      return battery;
    },
    getDetections: async () => {
      calls.count += 1;
      return events;
    },
    close: async () => {},
  };
}
