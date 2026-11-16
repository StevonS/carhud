'use strict';
/**
 * Settings: built-in defaults, then /etc/carhud.conf (KEY=VALUE, shell style), then the environment.
 * CARHUD_CONF=/path/to/file points at another config file (tests, development).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HOME = os.homedir();

const DEFAULTS = {
    HUD_PORT: '8078',
    ALLOW_LAN: '1',            // 1: the control panel and displays are reachable from other devices on the network
    ALLOW_LAN_SYSTEM: '0',     // 1: update / restart / reboot allowed from other devices too
    HUD_SOURCE: 'auto',        // what drives the HUD at start: auto | demo | manual | obd   (auto = obd when an adapter is plugged in)
    EVA_DIR: '/opt/evahud',
    EVA_WATCH: '0',            // 1: rebuild and restart the HUD app when its files change (for editing the HUD itself)
    DATA_DIR: path.join(HOME, '.carhud'),
    USER_APPS_DIR: path.join(HOME, 'carhud-apps'),
    MEDIA_DIR: path.join(HOME, 'Music'),
    DESK_HOME: '',             // a desk app to open at start instead of the launcher, e.g. gauges
    CARPLAY_URL: '',
    OBD_ENABLE: '1',
    OBD_DEVICE: 'auto',
    OBD_BAUD: 'auto',
    OBD_PROTOCOL: '0',         // ELM327 ATSP number, 0 = automatic
    OBD_MULTI: 'auto',         // several PIDs per request on CAN cars: auto | 0
    OBD_GEAR_RATIOS: '',       // engine rpm per km/h in each gear, comma separated (carhud gears ... works it out)
    OBD_FUEL_AFR: '14.7',      // stoichiometric AFR of the fuel, for AFR from lambda
    PHONE_BLUETOOTH: '1',      // the Bluetooth phone link (music, now playing, iPhone notifications)
    PHONE_NAME: 'CarHUD',      // what phones see
    PHONE_NOTIFICATIONS: '1',  // iPhone notifications over Bluetooth LE (ANCS)
    PHONE_ADAPTER: '',         // hci0 etc., empty = the first one
    PHONE_AUDIO_DEVICE: 'default',
    PHONE_PYTHON: 'python3',
    PHONE_HTTPS_PORT: '8443',  // the phone web app (GPS needs https)
    PHONE_TLS_DIR: '/var/lib/carhud/tls',
    PHONE_GEOCODER_URL: 'https://nominatim.openstreetmap.org',
    PHONE_ROUTER_URL: 'https://router.project-osrm.org',
    HUD_NAV: '1',              // show the next turn on the HUD while navigating
    PHONE_AP: 'auto',          // the car Wi-Fi hotspot: auto (when no known Wi-Fi) | on | off   (set up by the installer)
    PHONE_AP_SSID: 'CarHUD',
    PHONE_AP_PASSWORD: '',
};

function parse(text) {
    const out = {};
    text.split(/\r?\n/).forEach((line) => {
        const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (!m) return;
        let v = m[2];
        if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
        else v = v.replace(/\s+#.*$/, '');
        out[m[1]] = v;
    });
    return out;
}

function load() {
    const file = process.env.CARHUD_CONF || '/etc/carhud.conf';
    let fromFile = {};
    try { fromFile = parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* no file: defaults */ }
    const c = Object.assign({}, DEFAULTS, fromFile);
    Object.keys(DEFAULTS).forEach((k) => { if (process.env[k] !== undefined) c[k] = process.env[k]; });
    c.file = file;
    c.ROOT = ROOT;
    c.port = Number(c.HUD_PORT) || 8078;
    c.on = (k) => c[k] === '1' || c[k] === 'yes' || c[k] === 'true';
    return c;
}

module.exports = { load, parse, ROOT };
