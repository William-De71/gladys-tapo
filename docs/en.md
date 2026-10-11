# Tapo integration for Gladys Assistant

This integration adds your **TP-Link Tapo** cameras and doorbells to Gladys: the camera image on your dashboard, doorbell presses and motion detection as scene triggers, and the battery level of the wire-free models.

## How it works

Two channels, each doing what it is good at:

- **The TP-Link cloud** is used to find the list of your cameras. It is the same account as in the Tapo app. It does **not**, however, report the local address of the cameras.
- **A scan of your network** then locates each camera, exactly like the Tapo app does on startup. In most setups this saves you from typing any IP address (see [Your cameras' IP address](#your-cameras-ip-address) when it does not).
- **Your local network** delivers everything else: images, doorbell, motion, battery. None of it travels through the cloud: Gladys talks to the camera directly, at your home.

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
- otherwise, once the cameras are added (step 3), use the **Save a camera account** action at the bottom of the Configuration screen: pick the camera in the list, type the username and the password, run it. Gladys tries a capture right away and tells you whether the account works. Repeat for each camera.

Per-camera accounts take precedence over the default one, and stay attached to the camera even if you rename it. If you leave everything empty, the integration will use the proprietary mode for every camera.

The **Accounts per camera (advanced)** field still accepts a typed list (`name|username|password`, comma-separated), but the action is simpler and accepts any password, commas included.

On some models you also need to enable **Third-Party Compatibility** (in the Tapo app, under _Me_ → _Tapo Lab_) before the RTSP stream becomes reachable.

### 3. Run a scan

Click **Test the connection**: Gladys logs in to the cloud, scans your network and prints **one line per camera** — its address, where that address came from, and how the image will be captured:

```
Connected to the Tapo cloud: 3 device(s), 2 reachable on your network.
✔ Living room (C230): 192.168.1.20 (found on the network), images over RTSP
✔ Garage (C210): 192.168.1.21 (found on the network), images over RTSP
✖ Garden (C660): not found on your network → run "Set a device IP address" below.
```

Then go to the **Discover** screen and run a scan. Your cameras show up there, ready to be added. Once created, add the **Camera** widget to your dashboard.

If a camera is marked ✖, read on.

## Your cameras' IP address

To get the images, Gladys needs the **local IP address** of each camera (for example `192.168.1.42`). The TP-Link cloud does not provide it: the integration finds it by scanning your network, and recognizes each camera by its MAC address.

### When the scan does not find a camera

That happens when the camera is on **another subnet or VLAN** than Gladys, or when your router **filters broadcast** traffic. The fix:

1. In the Tapo app, open the camera, then **Settings** (gear icon) → **Device info**: the **IP address** is shown there.
2. In Gladys, on the integration's **Configuration** screen, scroll down to the **Set a device IP address** action.
3. Pick the camera in the list, type its address, run it.

Gladys checks right away that something answers at that address, captures an image and tells you whether everything works. The address is attached to the camera itself: it stays valid if you rename the camera, in Gladys or in the Tapo app.

To go back to automatic detection, run the action again with an **empty** address.

> **Tip** — reserve each camera's address in your router ("DHCP reservation" or "static lease"). Otherwise the router may hand it another one after an outage, and a typed address would become wrong.

### What about the cloud, without an IP address?

Not possible. TP-Link offers third-party applications **no way** to fetch a camera's image or stream over the Internet: the Tapo app goes through relay servers reserved for its own use. Every existing integration — Home Assistant's included — therefore works over the local network, which is also what guarantees your images never leave your home.

### The "Manual addresses (advanced)" field

It is still there for typing addresses by hand: comma-separated entries, each as `name|ip` (or `name=ip`), for example `Garden camera|192.168.1.42, Living room|192.168.1.43`. The name is matched without regard to case, accents, spaces or underscores, and may also be the camera's MAC address. The action above remains safer: no name to copy, and the address is checked.

## What battery cameras do — and do not do

Battery and solar models (C610, C425, D230…) expose neither RTSP nor ONVIF: they only speak TP-Link's proprietary protocol. That has two practical consequences.

### No live video

These cameras show **regularly refreshed images**, not a continuous stream. Gladys' live view relies on a URL handed to ffmpeg, and a proprietary session is encrypted and driven by the integration itself — it cannot be expressed as a URL. Wired RTSP cameras do get live video.

This is a limit of the protocol rather than of the integration: no tool does better on these models, short of going through an external relay such as go2rtc.

### The battery is protected automatically

Capturing an image is by far the most demanding thing asked of a camera. On a solar model, capturing too often drains the battery faster than the panel refills it — and a lithium cell taken too low may stop accepting charge altogether, which cannot be fixed remotely.

So the integration backs off on its own:

| Battery             | Automatic refresh | Widget, scene, doorbell |
| ------------------- | ----------------- | ----------------------- |
| above 60%           | yes               | yes                     |
| between 40% and 60% | paused            | yes                     |
| below 40%           | paused            | no                      |

A camera that went below the first threshold only resumes at **80%**, deliberately well above the pause threshold: resuming just over it would restart the drain immediately, and repeated shallow cycles wear the battery faster than one proper cycle. Avoid setting that level to 100%: a solar camera charges in bursts and rarely reads exactly full, which would leave it paused for good.

The battery level and the events keep being read in every case: they cost almost nothing, and they are what tells when the camera has recharged.

A battery camera that **stops answering** — deep sleep, refused session, network down — is also brought back to on-demand: its last known level can no longer be trusted, and a silent camera is more likely to be empty than fine.

### A capture interval of their own

Battery cameras have their **own refresh interval**, independent of the wired ones. Spacing out the captures of a solar model therefore costs nothing to the freshness of your mains-powered cameras.

| Setting                         | Default       | Applies to           |
| ------------------------------- | ------------- | -------------------- |
| Image refresh interval          | 60s           | wired cameras only   |
| Battery camera refresh interval | 900s (15 min) | battery/solar models |

This is the single most effective setting: what costs the battery is **waking the camera up**, far more than the image itself. In winter, or if your panel gets little sun, lengthen that interval and raise the pause threshold.

## Features created

Each camera becomes one device in Gladys:

- **Image** — the picture shown by the camera widget, refreshed on demand.
- **Doorbell** — a press on the button, usable as a scene trigger.
- **Motion** — motion detection, also usable as a trigger.
- **Battery** — the remaining level, as a percentage (battery models).

When someone rings, the integration immediately captures an image and pushes it to Gladys: the widget already shows the visitor by the time you open the notification.

### How events reach Gladys

Two possible paths, chosen automatically per camera:

| Path        | How it works                                            | Delay              |
| ----------- | ------------------------------------------------------- | ------------------ |
| **ONVIF**   | The camera tells Gladys the moment it detects something | near instant       |
| **Polling** | Gladys regularly asks the camera what it detected       | up to one interval |

ONVIF is clearly preferable for triggering a scene: a motion arrives within a second instead of waiting for the next check. All it needs is the **camera account** to be filled in — those are the credentials ONVIF uses, not your Tapo account.

It is also the only path that reports the **end** of a motion: the sensor goes back down when the camera says so, rather than after a fixed delay.

Wired cameras (C210, C200, C500…) generally offer ONVIF, which gives them a motion sensor they did not have before. Battery models do not offer it and stay on polling: that is not a problem, their detections still come through, just with a slight delay.

There is nothing to configure: if the camera account is filled in and the camera accepts ONVIF, the integration uses it; otherwise it polls the camera as before.

## Privacy mode

Tapo cameras have a privacy mode that physically covers the lens. It shows up in Gladys as a switch, usable in a scene — "when I get home, blind the living room camera".

It does not go through ONVIF (it is TP-Link's own feature) but through the same local channel as the battery level. No camera account is needed, then: your Tapo account password is enough, and battery models get it too.

The switch works **both ways**. A toggle made from the Tapo app shows up in Gladys at the next check, within the minute.

While privacy mode is on, the camera keeps streaming but only shows a black frame reading "Privacy Mode is on". The integration therefore does not capture it: the widget keeps its last useful image instead of turning black, and a battery camera is not woken up for nothing. Images resume as soon as privacy mode is turned off.

If a camera does not offer this feature, the switch simply is not created.

## Pointing a motorized camera (PTZ)

Motorized cameras (C200, C210, C225, C500…) can be aimed from Gladys: the arrows appear directly on the dashboard camera widget, next to the image.

Like the events, this goes through ONVIF and therefore needs the **camera account** to be filled in. The integration asks each camera what it can do: a camera that pans without a motorized zoom only shows the four arrows, and a fixed camera shows nothing at all. There are no capabilities for you to declare.

**The saved positions** you created in the Tapo app are picked up as they are, with their names. They appear in a dropdown below the arrows, and can be used in a scene — the most common use by far: "when I leave, point the camera at the door". Gladys neither creates nor renames positions: that stays in the Tapo app. If you add one, it shows up at the next scan.

Pressing an arrow moves the camera **one step**, not continuously. This is deliberate: a command sent from a scene, or a press whose release is lost, must stay a small movement rather than several seconds of rotation. Each step therefore ends on its own: even if Gladys loses contact with the camera right after, no movement is left running.

One note on speed: Tapo firmwares largely ignore the requested speed and derive the pace from the distance to travel. A step may therefore feel slow — that is the camera's behaviour, not a missing setting.

## Options

- **Image quality** — HD gives a sharper image, SD is lighter and faster to capture.
- **Manual addresses (advanced)** — see [Your cameras' IP address](#your-cameras-ip-address); the **Set a device IP address** action is simpler.
- **Event check interval** — how often the integration looks for a ring or a motion. Shorter reacts faster but talks to your cameras more often. This setting only affects cameras without ONVIF: those that use it tell Gladys on their own, with nothing to wait for.
- **Capture timeout** — how long a camera is given to deliver an image.

The **Refresh the images** action forces a new capture of every camera, handy to verify your setup.

## Troubleshooting

**"Connection refused"** — check the email and password of your Tapo account. Two-step verification on your TP-Link account prevents this login.

**The widget stays empty, the logs show `TAPO_CAMERA_IP_UNKNOWN`** — Gladys does not know the camera's address: the scan did not find it. Run **Test the connection** to see which cameras are affected, then follow [When the scan does not find a camera](#when-the-scan-does-not-find-a-camera).

**A camera has an address but does not answer** — **Test the connection** flags it with a ⚠ and says where the address came from. Check that the camera is powered on, on the same network as Gladys, and that **Third-Party Compatibility** is enabled in the Tapo app. If the address changed (no DHCP reservation), fix it with the **Set a device IP address** action.

**The widget shows an error even though the camera answers** — if the camera uses RTSP, make sure its camera account is filled in. This is by far the most common cause: the logs then show `TAPO_RTSP_ACCOUNT_MISSING`. Remember that this account is specific to each camera.

**No image from a battery doorbell** — these models go into deep sleep to save their battery and can take several seconds to answer. Raise the **capture timeout** if needed.

**Motion takes a while to come through** — the camera is most likely on the polling path. Check that its **camera account** is filled in: that is what lets ONVIF work, and therefore what makes motion instant. Battery models do not offer ONVIF at all.

**No motion detected on an ONVIF camera** — in the Tapo app, check that motion detection is enabled and privacy mode is off: a camera in privacy mode reports nothing at all.

**Cameras without an RTSP stream** — battery models and doorbells (C610, C425, D230…) expose neither RTSP nor ONVIF. That is not a blocker: the integration automatically falls back to the TP-Link proprietary protocol, the one the Tapo app uses, and captures their images without any camera account. The only difference: no live video for those cameras, just regularly refreshed images.

They sometimes wake up slowly: if a capture fails with a timeout message, raise the **capture timeout**.

## Privacy

Your Tapo credentials are stored by Gladys and are only used to reach the TP-Link cloud and your cameras. Images are captured on your local network and sent straight to your Gladys: they never go through any third-party server.
