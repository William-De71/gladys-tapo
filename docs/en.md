# Tapo integration for Gladys Assistant

This integration adds your **TP-Link Tapo** cameras and doorbells to Gladys: the camera image on your dashboard, doorbell presses and motion detection as scene triggers, and the battery level of the wire-free models.

## How it works

Two channels, each doing what it is good at:

- **The TP-Link cloud** is used to find the list of your cameras and to report their events (ring, motion, battery). It is the same account as in the Tapo app. It does **not**, however, report the local address of the cameras.
- **A scan of your network** then locates each camera, exactly like the Tapo app does on startup. This is what saves you from typing any IP address.
- **Your local network** delivers the images. They never travel through the cloud: Gladys talks to the camera directly, at your home.

To capture an image, the integration automatically picks one of two modes, depending on what the camera accepts:

| Mode            | When it is used                               | What it requires                         |
| --------------- | --------------------------------------------- | ---------------------------------------- |
| **RTSP**        | The camera exposes an RTSP stream (port 554)  | A camera account created in the Tapo app |
| **Proprietary** | The camera exposes no RTSP stream (port 8800) | Nothing beyond your Tapo account         |

The second mode is TP-Link's internal protocol, the one the mobile app uses. It makes it possible to get an image out of the models — often battery-powered — that offer no standard stream.

## Setup

### 1. Enter your Tapo account

In the **Configuration** screen of the integration, enter the email and password of your TP-Link / Tapo account, then pick the closest cloud region (Europe by default).

### 2. Create a camera account (recommended)

If your cameras are wired (C100, C200, C210, C500…), RTSP is the better mode: lighter and more robust. It requires a camera account created in the Tapo app:

1. Open the Tapo app and select your camera.
2. Go to **Camera settings** → **Advanced settings** → **Camera account**.
3. Set a username and a password.
4. Copy them into the **Camera account (RTSP)** section of the Gladys configuration.

Beware: this camera account is **not** your Tapo account, and it is created **per camera**. Two ways to fill it in:

- if you used the **same credentials** on every camera, simply fill the **Default account username / password** fields;
- otherwise fill in **Accounts per camera**, separating cameras with a **comma**, each in the form `name|username|password`:

```
Camera_jardin|gladys|MyPassword, Camera_salon|gladys|OtherPassword
```

The input is a single line, so the comma is what separates the cameras. A password containing a comma must therefore go in the default fields. Use the camera name exactly as it appears in the Tapo app. These accounts take precedence over the default one. If you leave everything empty, the integration will use the proprietary mode for every camera.

On some models you also need to enable **Third-Party Compatibility** (in the Tapo app, under _Me_ → _Tapo Lab_) before the RTSP stream becomes reachable.

### 3. Run a scan

Click **Test the connection** to check that your credentials are accepted: Gladys reports how many cameras were found and how many answer on your network.

Then go to the **Discover** screen and run a scan. Your cameras show up there, ready to be added. Once created, add the **Camera** widget to your dashboard.

## Features created

Each camera becomes one device in Gladys:

- **Image** — the picture shown by the camera widget, refreshed on demand.
- **Doorbell** — a press on the button, usable as a scene trigger (battery models).
- **Motion** — motion detection, also usable as a trigger (battery models).
- **Battery** — the remaining level, as a percentage (battery models).

When someone rings, the integration immediately captures an image and pushes it to Gladys: the widget already shows the visitor by the time you open the notification.

## Options

- **Image quality** — HD gives a sharper image, SD is lighter and faster to capture.
- **Camera addresses** — only needed when the cloud does not report the local address of a camera. One per line, in the form `name|ip`.
- **Event check interval** — how often the integration looks for a ring or a motion. Shorter reacts faster but talks to your cameras more often.
- **Capture timeout** — how long a camera is given to deliver an image.

The **Refresh the images** action forces a new capture of every camera, handy to verify your setup.

## Troubleshooting

**"Connection refused"** — check the email and password of your Tapo account. Two-step verification on your TP-Link account prevents this login.

**A camera is found but does not answer locally** — the integration logs state which case you hit: unknown address, or no port answering. If the scan does not locate it (another VLAN, broadcast filtered by your router), type its address into the **Camera addresses** field: it always wins.

**The widget shows an error even though the camera answers** — if the camera uses RTSP, make sure its camera account is filled in. This is by far the most common cause: the logs then show `TAPO_RTSP_ACCOUNT_MISSING`. Remember that this account is specific to each camera.

**No image from a battery doorbell** — these models go into deep sleep to save their battery and can take several seconds to answer. Raise the **capture timeout** if needed.

**Cameras without an RTSP stream** — battery models and doorbells (C610, C425, D230…) expose neither RTSP nor ONVIF. That is not a blocker: the integration automatically falls back to the TP-Link proprietary protocol, the one the Tapo app uses, and captures their images without any camera account. The only difference: no live video for those cameras, just regularly refreshed images.

They sometimes wake up slowly: if a capture fails with a timeout message, raise the **capture timeout**.

## Privacy

Your Tapo credentials are stored by Gladys and are only used to reach the TP-Link cloud and your cameras. Images are captured on your local network and sent straight to your Gladys: they never go through any third-party server.
