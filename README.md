# gladys-tapo

External integration bringing **TP-Link Tapo** cameras and doorbells to [Gladys Assistant](https://gladysassistant.com): camera snapshots on the dashboard, doorbell and motion events as scene triggers, and battery level.

📖 User documentation: [English](docs/en.md) — [Français](docs/fr.md)

## What it does

- **Discovery** through the TP-Link cloud: your cameras are listed automatically, no IP address to type.
- **Images captured locally**, never through the cloud, in one of two modes picked per camera:
  - **RTSP** when the camera exposes a stream (needs a camera account created in the Tapo app);
  - **the TP-Link proprietary protocol** (TCP 8800) for the models that expose no RTSP stream, typically the battery doorbells.
- **Events**: doorbell press, motion detection and battery level, polled from the cloud.
- A doorbell press **pushes a fresh image** right away, so the widget shows the visitor immediately.

## Architecture

```
index.js                    SDK wiring: handlers, actions, lifecycle
src/
  config.js                 defaults, normalization, free-text parsing
  devices.js                cameras -> Gladys devices and features
  tapo/
    constants.js            protocol values and device params
    cloud.js                TP-Link cloud client (login, camera list)
    rtsp.js                 RTSP URL + capture mode detection (port probing)
    snapshot.js             ffmpeg capture, both modes, size-bounded
    events.js               doorbell / motion / battery watcher
    stream/
      aesHelper.js          AES-128-CBC key derivation
      mediaSession.js       proprietary protocol state machine (port 8800)
```

The proprietary protocol modules are a Node.js port of [pytapo](https://github.com/JurajNyiri/pytapo)'s media stream implementation, the same approach go2rtc uses.

## Development

```bash
npm install
npm test          # node --test
npm run lint      # eslint
npm run format    # prettier
```

`ffmpeg` must be available to capture images; the Docker image installs it.

## Capture modes

The mode is decided by probing the camera, never by its model name: a camera without RTSP is not a camera without local access. Battery models and doorbells (C610, C425, D230…) close ports 554 and 2020 but serve their video over the proprietary protocol on port 8800 — verified end to end on a C610.

Live video is only available for RTSP cameras: it goes through the `CAMERA_URL` param handed to the rtsp-camera service, and an encrypted 8800 session cannot be expressed as a URL. Proprietary-mode cameras get regularly refreshed images instead.

## License

Apache-2.0
