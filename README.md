# CarHUD

A DIY car head-up display on a Raspberry Pi:

- **HUD screen**: the [EVA HUD](https://github.com/PenguinDukeYDAuto/idrive7-EVAHUD) graphics, reflected off the windshield
- **Desk screen**: a small touch desktop on the second display (gauges, HUD controls, OBD, music, system, your own apps)
- **OBD-II**: live data from the car through a USB ELM327 cable
- **Phone link**: Bluetooth music, now playing, iPhone notifications and calls, plus a phone app for GPS, navigation and viewing the HUD on the phone
- **Control panel**: a debugging page you open from your laptop or phone, with a live view of the HUD

Updating is one command, `carhud update`, which pulls this repo and redoes only what changed.

```
            ┌──────────── Raspberry Pi ─────────────┐
 OBD-II ──► │ carhud server (Node)                  │ ──HDMI──► HUD screen  (/hud)
 USB cable  │  ├─ OBD reader (ELM327)               │ ──DSI───► desk screen (/desk/)
            │  ├─ EVA HUD app (its own renderer)     │
            │  └─ web server :8078 ────────────────┼──Wi-Fi──► control panel on your laptop (/)
            └───────────────────────────────────────┘
```

---

## Install

### Fresh Pi
1. Flash **Raspberry Pi OS Lite (64-bit)** with Raspberry Pi Imager. In its settings, set the hostname to `carhud`, add a username and password and your Wi-Fi, and turn on SSH.
2. Boot it, SSH in (`ssh <you>@carhud.local`), then:
   ```
   sudo apt-get install -y git
   sudo git clone https://github.com/StevonS/carhud.git /opt/carhud
   sudo bash /opt/carhud/install.sh
   sudo reboot
   ```
   This takes 20–40 minutes on a Pi 3.

### From the v1 setup kit (the zip)
v2 replaces it. Your `/etc/carhud.conf` settings are kept and new ones are added.
```
sudo mv /opt/carhud /opt/carhud.old
sudo git clone https://github.com/StevonS/carhud.git /opt/carhud
sudo bash /opt/carhud/install.sh
sudo reboot
```

### Updating
```
carhud update            # or the Update button in the desk's System app
carhud update --check    # just see if there is one
```
Your settings, your desk apps (`~/carhud-apps`) and your music are never touched.

---

## Using it

### Control panel: `http://carhud.local/` (or `:8078`)
Open it from any device on the same network (`carhud url` prints the address).

- **Live view** of the HUD with layer outlines, a road backdrop, a mirrored view, 1:1 size, a frame-rate limit for slow Wi-Fi, and screenshots. The stats show redraws, data rate, frame age and round trip.
- **Source** decides what drives the HUD:

  | Source | What the HUD shows |
  |---|---|
  | **Auto** | OBD when the adapter answers, else the phone's GPS while it shares, else Demo (default) |
  | **Demo** | The HUD app's own 22 s loop: a drive, then every alert. It changes screens by itself. |
  | **Manual** | Exactly the values you set, held until you change them |
  | **OBD** | The car. Engine off shows the parked screens. |
  | **GPS** | Speed and G from the phone app when there's no OBD. The gear shows 1 while moving: GPS can't tell the gear. |
  | **Hold** | Freezes whatever is on the HUD right now, in Manual |

- **Signals**: sliders and number boxes for every value, gear buttons (P, R, 1–8), and presets (Idle, Highway, Pull 3rd, Shift light, Overheat, Overboost, Lean, Knock...). Moving any of them switches to Manual.
- **Drive mode**: Comfort / Sport / Sport+ / Eco Pro, each with its own HUD design.
- **HUD settings**: the HUD app's own settings (designs per mode, redline, shift point, alert limits, alert previews...).
- **OBD-II**: adapter, protocol, battery voltage, poll rate, every PID with its update rate, and the live rpm-per-km/h used for the gear.
- **Log** with level filter and search; **Streams** shows each connected screen and whether it is keeping up.

### The phone as the HUD: `/screen`
The full-screen HUD for a phone. See *Phone link* below.

### The HUD screen: `/hud`
URL options: `?mirror=1` `?flip=1` `?bmw=1` (BMW speed zone) `?native=1` (1:1) `?stats=1` `?fps=15`.
With a keyboard plugged in: **s** stats, **m** mirror, **f** flip, **o** outlines, **b** BMW zone, **n** native size, **r** reload.

### The desk: `/desk/`
The second screen's home screen. Built-in apps:

| App | |
|---|---|
| Gauges | Speed, gear, rpm bar and every reading the car gives (coolant, oil, boost, AFR, battery, throttle, load, intake, fuel, fuel rate...) |
| HUD | The HUD live, plus source, hold and drive mode buttons |
| OBD | Adapter status and every PID |
| Phone | Pair phones, now playing with controls and volume, iPhone notifications and calls |
| Navigate | The next turn, distance, time left and a route map |
| Music | Plays music and videos from `~/Music` |
| System | IP address, version, CPU temperature, under-voltage warning, and buttons for Update, Reload screens, Restart and Reboot |
| CarPlay | Appears when `CARPLAY_URL` is set (a CarPlay web player or anything else) |

**Your own apps:** add a folder to `~/carhud-apps/` with an `app.json` and an `index.html`. There's a `hello` example and a README in that folder. Your apps get the same live data and controls as the built-in ones.

### Command line: `carhud`
```
carhud status                     source, app, OBD, values
carhud source auto|demo|manual|obd
carhud hold
carhud set rpm=6500 speed=110 gear=3
carhud drive sport
carhud settings / carhud setting redline 6500
carhud obd                        adapter + every PID
carhud watch                      live values
carhud log -f                     follow the log
carhud restart [--rebuild]        restart the HUD app
carhud reload                     reload all screens
carhud screens [set|rotate|identify]   what each display shows (see Screens)
carhud screens --windowed|--stop
carhud audio [set <id|auto>|test|volume N]   sound output (car AUX)
carhud gears 4.111 245/40R18 3.454 1.947 1.296 0.972 0.780 0.666
carhud phone                      Bluetooth phone, music, GPS, route
carhud pair                       let a new phone pair (3 min), shows how it goes
carhud phone --check              why Bluetooth / pairing isn't working
carhud play|pause|next|prev
carhud wifi [hotspot [min] [open]|home|log]
carhud nav test [kmh]|stop|end    a test route and a pretend drive
carhud update
```

---

## OBD-II

1. Plug a **USB ELM327** cable (FTDI- or CH340-based cables are the reliable ones) into the Pi and the car's OBD port, and turn the ignition on.
2. With `HUD_SOURCE=auto` (the default), the HUD switches to the car by itself. The OBD panel or `carhud obd` shows what the car answers.
3. **Set your gear ratios** so the HUD shows the right gear. OBD-II doesn't report gear, so CarHUD works it out from rpm ÷ speed:
   ```
   carhud gears <final drive> <tyre size> <gear ratios...>
   ```
   Put the `OBD_GEAR_RATIOS=` line it prints into `/etc/carhud.conf`, then `sudo systemctl restart carhud`. Check it while driving: `carhud obd` shows rpm per km/h live.

What it reads (when the car supports it): rpm, speed, coolant, oil temperature, manifold pressure (gives boost), barometric pressure, throttle/pedal, load, timing, intake air, MAF, fuel rail pressure, wideband lambda (gives AFR), fuel level, fuel rate, battery voltage and torque. It works out gear, boost, longitudinal G (from speed changes), AFR and fuel use from those. Knock isn't part of standard OBD-II.

On CAN cars (most since 2008) it asks for up to six readings per request, and falls back to one at a time if the adapter can't do that. Readings are prioritised: rpm, speed, boost and throttle every round, temperatures every twelfth.

**Testing without a car:** `python3 /opt/carhud/test/fake_elm327.py --link /tmp/fake-obd` runs a pretend adapter and car. Set `OBD_DEVICE=/tmp/fake-obd` and restart carhud. `--no-car` acts like ignition off; `--no-multi` acts like a basic adapter.

---

## Phone link (a home-made CarPlay)

Real CarPlay needs Apple's licensed chip, so CarHUD builds its own version from two connections. Both work with iPhone and Android.

**Bluetooth** (pair once; the phone reconnects by itself):
- **Pairing**: tap *Pair a phone* (desk Phone app, control panel or phone app), or run `carhud pair`. Within 3 minutes, pick **CarHUD** in the phone's Bluetooth settings and tap Pair on the phone. While that window is open the Pi accepts by itself, so no screen is needed. (`PHONE_PAIR_CONFIRM=1` makes a screen confirm every pairing.) If it doesn't work, run `carhud phone --check`.
- **Music**: anything the phone plays comes out of the Pi (`PHONE_AUDIO_DEVICE`; the 3.5 mm jack is `plughw:CARD=Headphones`).
- **Now playing**: song, artist, app and progress on the desk, with play/pause/skip and volume.
- **iPhone notifications**: banners on the desk, including **Answer / Decline for calls**. On the iPhone, turn on *Share System Notifications* for CarHUD (Settings → Bluetooth → ⓘ). Android doesn't offer this to accessories.

**The phone as the HUD screen** (no display needed): open `http://10.42.0.1/screen` on the car hotspot, or `http://carhud.local/screen` at home, or tap *Show HUD* in the phone app. Add it to the home screen (iPhone: Share → *Add to Home Screen*) and it opens straight into a full-screen HUD with no browser bars. Tap the screen for:
- **Mirror**: for laying the phone on the dash under the windshield as a reflection HUD.
- **Flip** and **Turn**: to suit how it lies. An upright phone turns the HUD sideways by itself.
- **Size**, **Height** and **Dim**: for night.

These are remembered on each phone. Set the phone's brightness to full, and Auto-Lock to Never if the screen still sleeps.

**The phone app** over Wi-Fi: `https://carhud.local:8443/phone/`, or `https://10.42.0.1:8443/phone/` in the car:
- **Show HUD**: the live HUD full-screen on the phone. Handy without a display, and with **Mirror** a phone lying on the dash works as a reflection HUD.
- **Share location**: the phone's GPS gives the HUD its speed and G-forces when there's no OBD. *Auto* switches to it by itself; OBD still wins when connected.
- **Navigate**: search a place and the phone plans the route with its own mobile data (OpenStreetMap's Nominatim + OSRM). The Pi then follows it. The next turn and distance show on the HUD, where BMW's speed readout would be. The desk's **Navigate** app shows the turn, distance left, arrival time and a route map. Leaving the route makes the phone find a new one.
- Keep the page open while driving: phones stop sharing location from background pages. The app keeps the screen on.

**Wi-Fi in the car**: when no known network is in range, the Pi starts its own hotspot (`PHONE_AP=auto`). Its name and password are on the desk's System app, and in `/etc/carhud.conf`. Phones keep using mobile data for the internet while connected. Switch by hand with `carhud wifi hotspot` / `carhud wifi home`, or the System app. `carhud wifi hotspot 15` tries it for 15 minutes, then goes back to home Wi-Fi. If the hotspot doesn't start, the Pi goes back to home Wi-Fi within a minute, and `carhud wifi log` says why. The log also records each phone's attempt to join (refused for a wrong password, joined, got an address). If a phone can't join, `carhud wifi hotspot 10 open` starts a password-free test hotspot to narrow it down.

**One-time phone setup** (for location): open `http://carhud.local:8078/phone/setup.html` (in the car: `http://10.42.0.1:8078/phone/setup.html`) and follow it. You install the Pi's certificate, because phones only share GPS with secure pages, then add the app to the home screen.

**Testing without a phone or a car**: the control panel's *Phone & navigation* card, or `carhud nav test` (a 1.6 km loop and a pretend drive), plus *Test notification* / *Test call*. `python3 test/test_bt_helper.py` checks the Bluetooth side against a simulated BlueZ; it needs `pip install python-dbusmock`.

**A real CarPlay dongle**: set `CARPLAY_URL` to its player and a CarPlay tile appears on the desk.

## Screens
Every display shows whatever you choose, and you can swap them at any time:

| Screen | |
|---|---|
| HUD | the HUD, with Mirror / Flip per display |
| Desk | the touch home screen |
| Console | the control panel, for debugging on a display in the car |
| Gauges, Navigation, Phone & music | one desk app, full screen |
| Black | the display stays on with nothing on it |
| Web address | any page, e.g. a CarPlay dongle player |
| Desktop | no CarHUD window: the plain Pi desktop with its terminal |
| Off | the display is turned off |

Choose in the control panel (**Screens**), the desk's **System** app, or:
```
carhud screens                         what each display shows
carhud screens set HDMI-1 console      e.g. the control panel on HDMI
carhud screens set DSI-1 hud mirror    the HUD, mirrored, on the DSI screen
carhud screens rotate DSI-1 left       turn a display
carhud screens identify                each display shows its name for 5 s
```
Changes swap instantly. Each display runs one page (`/display?output=NAME`) that changes its content without restarting.

## Sound output (car AUX)
All sound goes to one output: phone music over Bluetooth, the desk's Music app and the test sound.
- **Automatic** (the default) uses a **USB sound card** as soon as one is plugged in, otherwise the 3.5 mm jack. A USB sound card into the car's AUX input is the cleanest way to the car's speakers.
- If you hear a whine that rises with engine speed, that's a ground loop. A **ground loop isolator** on the AUX cable fixes it.
- Choose, test and set the volume in the control panel (**Sound output**), the desk's System app, or with `carhud audio`, `carhud audio set Device`, `carhud audio test` and `carhud audio volume 80`.

## Screens on a Pi 3
One HDMI port and one DSI connector: the HUD goes on HDMI (a bright 800×480 panel is ideal), and the desk goes on DSI (e.g. the official 7" touchscreen, whose touch input is mapped to it automatically). Settings: `HUD_OUTPUT`, `DESK_OUTPUT`, `HUD_MIRROR`, `HUD_FLIP` in `/etc/carhud.conf`. With one monitor, `carhud screens --windowed` shows both as windows.

## Settings
All in `/etc/carhud.conf`, with comments. Restart after changes: `sudo systemctl restart carhud` (screen settings: `carhud screens`).

## Debugging checklist
- `carhud status` / `carhud log -f` / `journalctl -u carhud -f`
- HUD looks laggy? Open `/hud?stats=1` on the Pi: **frame age** should be a few ms. On the control panel, the Streams table shows whether a screen is skipping frames (it never queues old ones).
- HUD stuck on one screen? Check the Source: Demo loops by itself; Manual holds whatever you set.
- Editing the HUD graphics? Set `EVA_WATCH=1`, and saving files in `/opt/evahud` rebuilds and restarts it.

---

## Developing
- Run it on your laptop: `CARHUD_CONF=./dev.conf node server/main.js` with `EVA_DIR=` pointing at a baked copy of idrive7-EVAHUD, then open http://localhost:8078.
- Workflow: change → commit → push → `carhud update` on the Pi.
- No npm dependencies: Node's standard library only, so updates don't need `npm install`.

| Path | |
|---|---|
| `server/main.js` | the server: sources, HTTP API, WebSocket |
| `server/render.js` | the stand-in for the car's cluster-render that the HUD app draws through |
| `server/stream.js` | sends only changed pixels; a slow screen gets the newest picture, never a backlog |
| `server/eva.js` | builds and runs the HUD app |
| `server/obd/` | ELM327 driver, PID table, gear/boost/AFR maths |
| `server/phone/` | Bluetooth helper (Python + BlueZ D-Bus), GPS, route following |
| `web/phone/` | the phone app and its setup page |
| `web/` | control panel (`index.html`), HUD screen (`hud.html`), shared JS |
| `desk/` | the desk and its built-in apps |
| `system/` | config, service, screens script, updater |
| `eva.ref` | the HUD project version this release uses (updates move it on deliberately) |

### API
`GET /api/state`, `/api/values`, `/api/obd`, `/api/settings`, `/api/logs`, `/api/system`
`GET /api/phone`; `POST /api/phone/{discoverable,pair,media,volume,connect,disconnect,forget,notification,gps,route,route/clear,simulate,test-notification}`
`POST /api/source {source}`, `/api/hold`, `/api/manual {values, reset}`, `/api/drive {value}`, `/api/setting {key, value}`, `/api/app/restart {rebuild}`, `/api/obd/reconnect`, `/api/displays/reload`, `/api/system/{update,screens,restart,reboot}`
WebSocket `/ws`: `?target=hud` for the pixel stream; JSON messages `state`, `values`, `obd`, `settings`, `status`, `log` (with `?log=1`).

## Credits
- HUD graphics and app: [idrive7-EVAHUD](https://github.com/PenguinDukeYDAuto/idrive7-EVAHUD) by DukeAPenguin (MIT), built on bimmer-lab's HUD engine (MIT) and cauliflowermossgrape's MGU App Kit (MIT). It's downloaded at install, not included here. It's an unofficial fan project using Evangelion's look.
- `server/render.js` and `web/js/hudview.js` are adapted from that project's bench (MIT).
- Fonts: Barlow (OFL) and Shippori Mincho B1 (OFL), downloaded at install. MatissePro is commercial and is never included.
