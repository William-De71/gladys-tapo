// Minimal stand-in for the Gladys SDK instance, exposing only what the modules
// under test call. Keeping it tiny is deliberate: a fake that mirrors the whole
// SDK would pass even when the real contract changed.

/**
 * Build a fake Gladys SDK instance.
 * @param {object} [options] - Options.
 * @param {string} [options.selector] - The integration selector.
 * @param {Array} [options.devices] - The devices the user "created".
 * @param {Function} [options.failPublishState] - Called before each state is
 * recorded; returning true makes that publish REJECT, the way the host does
 * when it rate-limits or the socket is down.
 * @returns {object} The fake instance, with a `published` log for assertions.
 * @example
 * const gladys = fakeGladys({ devices: [device] });
 */
export function fakeGladys({
  selector = 'ext-dev-tapo',
  devices = [],
  scanResults,
  failPublishState = () => false,
} = {}) {
  const published = { states: [], devices: [], images: [] };

  return {
    selector,
    // EMPTY on purpose, while `getDevices()` below returns the real list. The
    // SDK only refreshes this property when the WebSocket (re)connects, so on
    // the `config-updated` path it is stale — and it was empty in production
    // exactly when the code read it. Mirroring the list into it here is what
    // made a broken ONVIF setup pass its tests.
    devices: [],
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
      if (failPublishState({ featureExternalId, value })) {
        throw new Error('too many states published');
      }
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
 * @param {boolean|null} [options.privacy] - Its privacy mode; null stands for a
 * camera whose firmware has no lens mask.
 * @returns {object} The fake client.
 * @example
 * const api = fakeLocalApi({ battery: 91 });
 */
export function fakeLocalApi({ events = [], battery = null, privacy = null } = {}) {
  const calls = { count: 0 };
  /** What `setPrivacyMode` was last asked for, so a command can be asserted. */
  const written = { privacy: null };
  return {
    calls,
    written,
    getBatteryLevel: async () => {
      calls.count += 1;
      return battery;
    },
    getDetections: async () => {
      calls.count += 1;
      return events;
    },
    // Deliberately NOT counted in `calls`: that counter exists to assert which
    // cameras were polled for their detections, and adding a second increment
    // per round would break that reading for reasons unrelated to the test.
    getPrivacyMode: async () => privacy,
    setPrivacyMode: async (enabled) => {
      written.privacy = enabled;
    },
    close: async () => {},
  };
}
