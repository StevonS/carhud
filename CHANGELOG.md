# Changelog

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
