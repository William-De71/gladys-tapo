# gladys-tapo

External integration bringing **TP-Link Tapo** cameras and doorbells to [Gladys Assistant](https://gladysassistant.com): camera snapshots on the dashboard, doorbell and motion events as scene triggers, and battery level.

📖 User documentation: [English](docs/en.md) — [Français](docs/fr.md)

## What it does

- **Discovery** through the TP-Link cloud: your cameras are listed automatically, no IP address to type.
- **Images captured locally**, never through the cloud, in one of two modes picked per camera:
  - **RTSP** when the camera exposes a stream (needs a camera account created in the Tapo app);
  - **the TP-Link proprietary protocol** (TCP 8800) for the models that expose no RTSP stream, typically the battery doorbells.
- **Events**: doorbell press, motion detection and battery level. Motion arrives **pushed over ONVIF** (TCP 2020) on the cameras that serve it — the camera holds the request open and answers the instant it detects something, instead of being asked every N seconds. Cameras without ONVIF fall back to polling their local detection list.
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
    onvif.js                ONVIF pull point events (port 2020), motion pushed
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

Bridging the 8800 stream through an HTTP server inside the integration does not
work either, and the reason is worth recording: the `gladys-integrations` network
is created with `com.docker.network.bridge.enable_icc=false`, so nothing can
connect INTO an integration container — not even Gladys, which is where ffmpeg
runs. Verified by reproducing the exact network options. The only route left
would be a sub-container, whose ports Gladys publishes on the host; that means
embedding a relay such as go2rtc, which is out of scope here.

Battery models are also throttled to protect the cell: below 60% the periodic
capture stops, below 40% nothing is captured, and a camera only resumes once
fully recharged. Both thresholds are configurable.

## Events

Motion and doorbell rings reach Gladys by whichever of two paths the camera supports. The choice is made per camera by probing port 2020, for the same reason the capture mode is: measured on a C210 the port is open and answers, on a C610 it is closed.

| Path                     | How it works                                                          | Latency        |
| ------------------------ | --------------------------------------------------------------------- | -------------- |
| **ONVIF** (TCP 2020)     | `PullMessages` is held open by the camera, which answers on detection | ~instant       |
| **Local detection list** | `searchDetectionList` is polled every `event_poll_interval`           | up to one poll |

ONVIF is what makes a motion usable as a scene trigger, and it is the only path that reports the **falling** edge — so the sensor comes back down when the camera says the motion ended, rather than on a timer. It needs the camera account (the ONVIF credentials are that account, not the Tapo one), so a camera without one stays on the polled path.

Probing port 2020 is also what gives a WIRED camera a motion sensor: those have no local detection list, so before ONVIF they carried no event feature at all.

The two paths never run together on the same camera: they report the same detections, so a camera covered by ONVIF is skipped by the polled path entirely — otherwise every motion would fire its scene twice. The battery level keeps being read either way, since ONVIF does not carry it.

The SOAP is written out by hand rather than pulled from a WSDL stack: the integration makes three calls (`GetCapabilities`, `CreatePullPointSubscription`, `PullMessages`) out of a standard covering hundreds. Two things measured on a C210 and worth keeping in mind: device management is served on `/onvif/device_service` but every other service, Events included, on `/onvif/service` — so the address is read from the capabilities rather than assumed; and `UtcTime` is an attribute of `<tt:Message>`, not an element.

## License

Apache-2.0
