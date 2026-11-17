# Changelog

## 2.4.1
- LCD: the server remembers where the LCD's area is, so touch calibration still applies after a
  `systemctl restart carhud` without re-doing the screen layout.

## 2.4.0
- 3.5" SPI touch LCD on the header pins (Waveshare 3.5" A/B/C and clones, MHS-3.5, "LCD35-show" boards):
  `sudo carhud lcd setup <model>` and a reboot, or the control panel's 3.5" LCD card. It becomes a screen
  called LCD, placed beside the other displays and copied to the LCD; touch is mapped to it, with a
  5-tap calibration (`carhud lcd calibrate`). No vendor LCD-show scripts needed; leftovers from them are
  pointed out.
- Debug console: a compact touch screen for small displays (the LCD's default): status, address, Wi-Fi,
  power, OBD, phone, live values, the log, and big buttons (source, hold, reconnect OBD, reload screens,
  re-do layout, restart app, hotspot, pair, restart CarHUD, reboot). Any display can show it.
- Terminal: a new screen type, a full-screen command line on any display.

## 2.3.0
- Interchangeable screens: each display can show the HUD, the desk, the Console (control panel), Gauges,
  Navigation, Phone & music, black, any web address, the plain Desktop (for a terminal and debugging), or
  nothing (off). It can also be turned (rotated). Choose in the control panel's Screens card, the desk's
  System app or with `carhud screens set <output> <screen>`. Most changes swap instantly with no window
  restart; `carhud screens identify` shows each display's name on it.
- Sound output (AUX): pick where all sound goes: a USB sound card for the car's AUX, the 3.5 mm jack or
  HDMI. Automatic prefers a USB sound card the moment one is plugged in. Phone music and the browser play
  at once (shared ALSA device). Test sound and volume in the control panel, the desk or `carhud audio`.

## 2.2.3
- Hotspot: full NetworkManager setting names (802-11-wireless-security.*) everywhere. `carhud wifi` failed
  with "invalid field 'wifi-sec.proto'": nmcli only accepts the short alias when changing settings,
  not when reading them.

## 2.2.2
- Hotspot: the way back to home Wi-Fi is a systemd timer (carhud-wifi-return), so it happens even when
  the background switch is gone, and returns to the exact network the Pi was on.
- The hotspot's name and password are re-applied from /etc/carhud.conf on every switch, so the printed
  password is the one in use. `carhud wifi` shows the real password and flags a mismatch.
- While the hotspot runs, each phone's attempt to join is logged: refused for a wrong password, joined,
  got an address (`carhud wifi log`).
- `carhud wifi hotspot 10 open`: an open test hotspot "<name>-test", to rule password problems out.
- No power saving on the hotspot; IPv6 off on it.

## 2.2.1
- Hotspot fix: the hotspot profile now uses settings the Pi's Wi-Fi chip accepts (WPA2/CCMP only,
  protected management frames off, a fixed channel: PHONE_AP_CHANNEL, default 6). These are re-applied on
  every switch, and dnsmasq is installed if missing.
- `carhud wifi hotspot [minutes]` switches in the background, so it survives SSH dropping. It checks the
  Wi-Fi country, dnsmasq and rfkill first, falls back to home Wi-Fi within a minute if the hotspot doesn't
  come up, and writes what NetworkManager and the driver said to /var/log/carhud-wifi.log (`carhud wifi log`).
  With minutes, it returns to home Wi-Fi by itself.

## 2.2.0
- The phone as the HUD screen: `/screen` is a full-screen HUD page. Add it to the home screen and it
  opens straight into the HUD with no browser bars. Tap for Mirror, Flip, Turn (upright phones), size,
  height and dimming, all remembered per phone. Keeps the screen on and reconnects by itself.
- Plain addresses: also answers on port 80, so `http://10.42.0.1` (car hotspot) and `http://carhud.local`
  work. Phones opening the address land on the phone app.
- Pairing fixed for setups without a desk screen: phones now pair by themselves while the pairing
  window is open (you confirm the code on the phone). PHONE_PAIR_CONFIRM=1 asks a screen every time.
  The prompt, code and errors show on the desk, the control panel, the phone app and `carhud pair`.
- `carhud pair` follows the pairing live; `carhud phone --check` finds out why Bluetooth isn't working.
- Pair buttons say what went wrong (Bluetooth off, not running, no adapter).

## 2.1.0
- Phone link, a home-made CarPlay:
  - Bluetooth pairing confirmed on the desk, with auto-reconnect.
  - Phone music through the Pi (bluez-alsa), now playing, controls and volume.
  - iPhone notifications with Answer / Decline for calls (ANCS).
- Phone app over Wi-Fi/https: shows the HUD full-screen on the phone (with mirror), shares GPS,
  searches places and routes with the phone's own data.
- Navigation: the Pi follows the route; the next turn on the HUD and a Navigate app on the desk, with
  reroute when you leave the route.
- GPS source: Auto uses the phone's GPS when there is no OBD.
- Car Wi-Fi hotspot when no known network is in range; own certificate so phones allow location.
- Desk: Phone and Navigate apps, pairing prompt, notification and call banners, now-playing in the bar.
- Control panel: Phone & navigation card with test route, test drive, test notification and call.
- `carhud phone | pair | play | pause | next | prev | wifi | nav`.

## 2.0.0
- CarHUD is a git project: `carhud update` pulls it and redoes only what changed.
- Own server in place of the HUD project's bench page: only changed pixels are sent, and each screen
  acknowledges what it gets, so a slow screen gets the newest picture instead of a backlog (low latency
  on the Pi's HDMI and over Wi-Fi).
- Sources: Auto, Demo, Manual, OBD, plus Hold. Manual holds exactly what you set; the screen never
  switches views by itself.
- OBD-II over a USB ELM327 cable: auto-detect, multi-PID requests on CAN, gear from rpm/speed, boost,
  AFR, G, fuel use; handles ignition off and unplugging.
- Desk: a touch home screen for the second display with Gauges, HUD, OBD, Music and System apps, plus
  your own apps in ~/carhud-apps. Replaces v1's CarPlay placeholder (CARPLAY_URL now adds a tile).
- Control panel: live view with stats, signals with presets, HUD settings, OBD table, log, streams.
- `carhud` command line tool; `/hud` display options and keyboard shortcuts.

## 1.0.0
- Setup kit zip: desktop, SSH, the HUD project's bench simulator, two-screen launcher.
