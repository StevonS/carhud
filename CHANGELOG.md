# Changelog

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
