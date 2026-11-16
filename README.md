# CarHUD

A DIY car head-up display on a Raspberry Pi:

- **HUD screen**: the [EVA HUD](https://github.com/PenguinDukeYDAuto/idrive7-EVAHUD) graphics, reflected off the windshield
- **Desk screen**: a small touch desktop on the second display (gauges, HUD controls, OBD, music, system, your own apps)
- **OBD-II**: live data from the car through a USB ELM327 cable
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

### Control panel: `http://carhud.local:8078/`
Open it from any device on the same network (`carhud url` prints the address).

- **Live view** of the HUD with layer outlines, a road backdrop, a mirrored view, 1:1 size, a frame-rate limit for slow Wi-Fi, and screenshots. The stats show redraws, data rate, frame age and round trip.
- **Source** decides what drives the HUD:

  | Source | What the HUD shows |
  |---|---|
  | **Auto** | OBD when the adapter is plugged in and answering, otherwise Demo (default) |
  | **Demo** | The HUD app's own 22 s loop: a drive, then every alert. It changes screens by itself. |
  | **Manual** | Exactly the values you set, held until you change them |
  | **OBD** | The car. Engine off shows the parked screens. |
  | **Hold** | Freezes whatever is on the HUD right now, in Manual |

- **Signals**: sliders and number boxes for every value, gear buttons (P, R, 1–8), and presets (Idle, Highway, Pull 3rd, Shift light, Overheat, Overboost, Lean, Knock...). Moving any of them switches to Manual.
- **Drive mode**: Comfort / Sport / Sport+ / Eco Pro, each with its own HUD design.
- **HUD settings**: the HUD app's own settings (designs per mode, redline, shift point, alert limits, alert previews...).
- **OBD-II**: adapter, protocol, battery voltage, poll rate, every PID with its update rate, and the live rpm-per-km/h used for the gear.
- **Log** with level filter and search; **Streams** shows each connected screen and whether it is keeping up.

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
carhud screens [--windowed|--stop]
carhud gears 4.111 245/40R18 3.454 1.947 1.296 0.972 0.780 0.666
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
| `web/` | control panel (`index.html`), HUD screen (`hud.html`), shared JS |
| `desk/` | the desk and its built-in apps |
| `system/` | config, service, screens script, updater |
| `eva.ref` | the HUD project version this release uses (updates move it on deliberately) |

### API
`GET /api/state`, `/api/values`, `/api/obd`, `/api/settings`, `/api/logs`, `/api/system`
`POST /api/source {source}`, `/api/hold`, `/api/manual {values, reset}`, `/api/drive {value}`, `/api/setting {key, value}`, `/api/app/restart {rebuild}`, `/api/obd/reconnect`, `/api/displays/reload`, `/api/system/{update,screens,restart,reboot}`
WebSocket `/ws`: `?target=hud` for the pixel stream; JSON messages `state`, `values`, `obd`, `settings`, `status`, `log` (with `?log=1`).

## Credits
- HUD graphics and app: [idrive7-EVAHUD](https://github.com/PenguinDukeYDAuto/idrive7-EVAHUD) by DukeAPenguin (MIT), built on bimmer-lab's HUD engine (MIT) and cauliflowermossgrape's MGU App Kit (MIT). It's downloaded at install, not included here. It's an unofficial fan project using Evangelion's look.
- `server/render.js` and `web/js/hudview.js` are adapted from that project's bench (MIT).
- Fonts: Barlow (OFL) and Shippori Mincho B1 (OFL), downloaded at install. MatissePro is commercial and is never included.
