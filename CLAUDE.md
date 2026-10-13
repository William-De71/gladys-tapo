# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for TP-Link Tapo devices (cameras,
doorbells, plugs, power strips, bulbs, light strips, wall switches, H100 hub
sensors): a Node.js service (Node 22+, ESM, no build step) running in its own
sandboxed Docker container, talking to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js)
(0.15). `type: "device"`, transports `local` + `cloud`, Gladys >= 5.1.0. The
TP-Link cloud only lists the devices; everything else is local: devices are
located by a TDP probe Gladys broadcasts on UDP 20002 (`udp-active-broadcast`),
cameras are reached over RTSP 554 / the proprietary protocol 8800 (images,
through ffmpeg), ONVIF 2020 (events, PTZ) and HTTPS 443 (local API: battery,
detections, privacy), the SMART devices over HTTP 80 (KLAP or
securePassthrough). A camera detection is a scene trigger.

## Commands

```bash
npm install
npm test                                  # node --test, fake cameras and devices on localhost only
node --test test/app.test.js              # one file
node --test --test-name-pattern "scene"   # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store . --skip-image-check
```

`ffmpeg` must be on the PATH to capture real images (the Docker image installs
it); the tests do not need it.

## Architecture

```
index.js                         SDK wiring only: createApp(gladys), shutdown, last-resort guards, connect
src/app.js                       every handler, registered before connect(); the tests drive it with
                                 the fake Gladys of the SDK (test/app.test.js)
src/sceneEvents.js               scene trigger `detection` (cooldown per camera and kind)
src/config.js                    defaults (DEFAULT_CONFIG), normalization, free-text fields, action stores
src/devices.js                   cameras -> Gladys devices and features, address resolution
src/report.js                    "Test the connection" report and status messages, en / fr / de / es
src/tapo/cloud.js                TP-Link cloud client (login, device list)
src/tapo/discovery.js            TDP probe (UDP 20002), MAC matching, one-minute scan cache
src/tapo/rtsp.js                 RTSP URL, capture mode by port probing
src/tapo/snapshot.js             ffmpeg capture (RTSP or 8800 MPEG-TS), size-bounded
src/tapo/stream/                 proprietary stream protocol (port 8800) and its AES key derivation
src/tapo/localApi.js             camera local API (HTTPS 443): battery, detections, privacy mode
src/tapo/onvif.js                ONVIF pull point (port 2020), event and detection kinds
src/tapo/ptz.js                  ONVIF PTZ steps and presets
src/tapo/events.js               EventWatcher: doorbell, motion, battery, privacy, ONVIF or polled
src/tapo/batteryGuard.js         capture and poll throttling of battery cameras
src/tapo/constants.js            protocol values, timings, device params, feature suffixes
src/smart/                       plugs, strips, bulbs, switches, hub sensors: http, klap, aes
                                 (securePassthrough), client, model (answers -> features), manager
                                 (polling, change-only publishing, transport badges, commands)
.github/scripts/release.mjs      version, changelog, version files, PR title checks
```

## Rules

- **Forever fields**: device and feature external ids
  (`ext:<selector>:<camera|plug|light|switch|sensor>:<id>[:<feature>]`, `id`
  being the cloud device id, or the child id for a strip socket or a hub
  sensor), and for each feature its `category`, `type`, `unit`, `min`, `max`,
  `read_only`, `has_feedback`; the device params; `should_poll: true` and
  `poll_frequency` (`POLL_FREQUENCY_MS`, 60 s) of the cameras — a change never
  reaches a device already created; the `config_schema` keys, the action keys
  and their field keys, the off-schema stores `device_addresses` and
  `camera_account_store`; the scene trigger key `detection`, its fields
  `camera` and `kind`, the `kind` values (`DETECTION_KINDS` in
  `src/sceneEvents.js`: `person`, `vehicle`, `pet`, `motion`, `doorbell`) and
  its variables `camera`, `name`, `kind`. `test/structure.test.js` checks the
  discovery against `test/fixtures/discovery.baseline.json` (built from
  `test/fixtures/discovery.inputs.json`) and the manifest against
  `test/fixtures/manifest.baseline.json` (v2.0.0). A change needs an entry in
  its `ALLOWED_CHANGES` with the migration, in the changelog, the docs and the
  forum message: users would have to delete and recreate their devices.
- **One network scan every 10 s** on the core side: go through
  `discoverDevices` in `src/tapo/discovery.js` (cached a minute,
  shared while in flight), never call
  `scanNetwork` directly. A device keeps its last known address when a scan
  fails.
- **Devices are matched on the MAC address**: a TDP reply carries a hashed
  `device_id`, not the cloud id. Addresses entered by the user (action store
  first, then the free-text field) win over the scan; both are keyed by the
  cloud device id, so a renaming keeps them.
- **Capabilities are asked of the device**, never guessed from the model: the
  capture mode from the open ports, PTZ from the ONVIF profile, the doorbell
  from the ONVIF topics, colour from the bulb's answer. "Unknown" (`null`) is
  never treated as "no": dropping a real feature breaks the user's scenes.
- **Battery cameras**: every wake-up costs the cell. They keep their own
  capture and poll intervals, the `batteryGuard` thresholds (pause, stop,
  resume) apply to every capture, a silent battery camera falls back to
  on-demand, and they never get an ONVIF pull point (held open, it keeps the
  radio awake). Doorbells are never throttled.
- **ONVIF or polling, never both** on one camera, or every motion fires twice.
  Subscriptions are renewed before they lapse and released on stop: the
  firmware keeps only a few.
- **States**: only changes are published (camera motion on its edges, SMART
  states through the manager's `published` map, transport badges only when
  they change), at most 100 per call; the host allows 300 states a minute. A
  device created is read at once (`onDeviceCreated`): first check and first
  image for a camera, a manager tick for a SMART device.
- **Scene events** on transitions only, flat scalar data limited to the
  declared variables, for created devices only. `detection` is quiet for
  `COOLDOWN_MS` (1 min) per camera and kind, and a `motion` within the cooldown
  of a `person` / `vehicle` / `pet` of the same camera is dropped. `person`,
  `vehicle`, `pet` only when the camera says so (ONVIF topic or labelled
  detection), otherwise `motion`; never guess. The motion fall waits a moment
  (firmwares slip a lone `false` into an ongoing motion), with a reset timer as
  a safety net. A scene event failure never blocks the states or the doorbell
  image.
- **Language**: Gladys does not send it with a command. Error messages and logs
  are in English; every text Gladys shows comes from the manifest or
  `src/report.js` / the inline messages of `src/app.js`, in four languages.
  Feature names are English only (`<name> - Motion`): the docs say so.
- **The container rootfs is read-only**: nothing is written outside `/data`,
  ffmpeg works through pipes; addresses and camera accounts set by the actions
  live in the integration config (`setConfig`).
- **User-facing text** exists in en, fr, de and es: manifest,
  `src/report.js`, inline messages, `docs/*.md`, `README*.md`.
  `test/manifest.test.js`, `test/report.test.js` and `test/i18n.test.js`
  check it. Images in `docs/*.md` use `raw.githubusercontent.com` URLs (the
  store re-hosts the docs), relative paths in the READMEs; they live in
  `docs/assets/`.
- **Versions belong to the Release workflow**: never edit `version` in
  `package.json`, `package-lock.json` or the manifest, nor the `docker_image`
  tag.
- **Changelog**: Ne jamais éditer CHANGELOG.md à la main, il est généré à la
  release. Écris le titre de PR comme la ligne que l'utilisateur lira.
- **Style**: Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never leave the machine.
