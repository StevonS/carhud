'use strict';
/**
 * carhud server: runs the EVA HUD app, streams it to the displays, reads the car over OBD-II,
 * and serves the control panel (/), the HUD display (/hud) and the second-screen desk (/desk/).
 *
 *   node server/main.js            (as the carhud service does)
 *   CARHUD_CONF=./my.conf node server/main.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFile } = require('child_process');

const config = require('./config');
const ws = require('./ws');
const { Renderer, TARGETS } = require('./render');
const { Streamer } = require('./stream');
const { Eva } = require('./eva');
const { Elm327 } = require('./obd/elm327');
const { Derive } = require('./obd/derive');
const https = require('https');
const { Phone } = require('./phone');
const { Screens } = require('./screens');
const { Lcd } = require('./lcd');

const cfg = config.load();
const ROOT = cfg.ROOT;
const SOCK = path.join(os.tmpdir(), 'carhud-render-' + process.pid + '.sock');

/* ---------- logging ---------- */
const logs = [];
const dataClients = new Set();
function log(level, text) {
    const e = { t: 'log', level, time: Date.now(), text };
    logs.push(e); if (logs.length > 600) logs.shift();
    (level === 'error' ? console.error : console.log)(new Date().toTimeString().slice(0, 8) + ' ' + level.padEnd(5) + ' ' + text);
    dataClients.forEach((c) => c.wantsLog && c.send(e));
}
function broadcast(obj, filter) { const s = JSON.stringify(obj); dataClients.forEach((c) => (!filter || filter(c)) && c.send(s)); }

/* ---------- version ---------- */
function gitHead(dir) {
    try {
        const head = fs.readFileSync(path.join(dir, '.git', 'HEAD'), 'utf8').trim();
        if (!head.startsWith('ref: ')) return head.slice(0, 7);
        const ref = head.slice(5);
        try { return fs.readFileSync(path.join(dir, '.git', ref), 'utf8').trim().slice(0, 7); } catch (e) { /* packed */ }
        const packed = fs.readFileSync(path.join(dir, '.git', 'packed-refs'), 'utf8').split('\n').find((l) => l.endsWith(' ' + ref));
        return packed ? packed.slice(0, 7) : '?';
    } catch (e) { return 'dev'; }
}
let VERSION = '?';
try { VERSION = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim(); } catch (e) { /* none */ }
const BUILD = VERSION + '-' + gitHead(ROOT) + '-' + Date.now().toString(36);    // displays reload when this changes

/* ---------- persistent state ---------- */
const DATA_DIR = cfg.DATA_DIR;
fs.mkdirSync(DATA_DIR, { recursive: true });
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const MANUAL_DEFAULTS = { rpm: 900, speed: 0, gear: 0, oil: 95, coolant: 90, boost: 0, gLong: 0, gLat: 0, torque: 0, pedal: 0, knock: 0, fuel: 120, afr: 14.7, burn: 8 };
let saved = {};
try { saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { /* first run */ }
const state = {
    source: 'demo',
    auto: cfg.HUD_SOURCE === 'auto' || !['demo', 'manual', 'obd', 'gps'].includes(cfg.HUD_SOURCE),
    manual: Object.assign({}, MANUAL_DEFAULTS, saved.manual || {}),
    drive: saved.drive === undefined ? null : saved.drive,
};
if (!state.auto) state.source = cfg.HUD_SOURCE;
let saveTimer = null;
function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => fs.writeFile(STATE_FILE, JSON.stringify({ manual: state.manual, drive: state.drive }, null, 1), () => {}), 500);
}

/* ---------- the HUD app and its renderer ---------- */
const renderer = new Renderer(SOCK);
renderer.on('log', log);
const streamer = new Streamer(renderer);
const eva = new Eva({ evaDir: cfg.EVA_DIR, dataDir: path.join(DATA_DIR, 'eva'), sockPath: SOCK, watch: cfg.on('EVA_WATCH') });
eva.on('log', log);
eva.on('state', () => broadcastState());
eva.on('settings', (s) => broadcast(Object.assign({ t: 'settings' }, s), (c) => c.wantsData));
eva.on('status', (s) => broadcast({ t: 'status', s }, (c) => c.wantsData));

/* ---------- OBD-II ---------- */
const obd = new Elm327(cfg);
const derive = new Derive(cfg);
let obdHud = {};
let lastObdPush = 0;
obd.on('log', log);
/** Auto: the car over OBD when the adapter answers, else the phone's GPS while it's sharing, else the demo. */
function autoPick() {
    if (obd.state === 'live' || obd.state === 'waiting') return 'obd';
    if (phone.gpsFresh()) return 'gps';          // the phone sharing its GPS (or the route simulator)
    return 'demo';
}
function reconsider(why) {
    if (!state.auto) return;
    const want = autoPick();
    if (want !== state.source) { log('info', 'source auto: ' + want + ' (' + why + ')'); setSource(want, true); }
}
obd.on('state', (s) => {
    reconsider('adapter ' + s);
    if (s !== 'live') { obdHud = {}; if (state.source === 'obd') applySource(); }
    broadcastState();
});
obd.on('data', (v) => {
    const now = Date.now();
    obdHud = derive.hud(v, now);
    if (state.source === 'obd' && now - lastObdPush >= 50) { lastObdPush = now; applySource(); }
});

/* ---------- the phone: Bluetooth + the phone web app ---------- */
const phone = new Phone(cfg);
let lastGpsPush = 0, lastNavSent = '';
phone.on('log', log);
phone.on('change', (ps) => {
    broadcast({ t: 'phone', phone: ps }, (c) => c.wantsData);
    const nav = navMsg();
    const key = JSON.stringify(nav);
    if (key !== lastNavSent) { lastNavSent = key; broadcast(nav); }
});
phone.on('pair', (p) => broadcast({ t: 'pair', pair: p }));
phone.on('pair-done', (p) => broadcast({ t: 'pair-done', done: p }));
phone.on('notification', (n) => broadcast({ t: 'notification', n }, (c) => c.wantsData));
phone.on('gps', () => {
    reconsider('phone GPS');
    const now = Date.now();
    if (state.source === 'gps' && now - lastGpsPush >= 100) { lastGpsPush = now; applySource(); }
});
setInterval(() => { if (state.auto && state.source === 'gps' && !phone.gpsFresh()) reconsider('phone GPS stopped'); }, 1000);
/** the small navigation message every screen gets (the HUD draws the next turn from it) */
function navMsg() {
    const n = phone.nav.route ? phone.nav.state() : null;
    if (!n || !n.progress) return { t: 'nav', active: !!n, show: cfg.on('HUD_NAV') };
    const p = n.progress;
    return { t: 'nav', active: true, show: cfg.on('HUD_NAV'), dest: n.dest && n.dest.name, left: p.left, eta: p.eta, arrived: p.arrived, offRoute: p.offRoute,
        next: p.next && { index: p.next.index, type: p.next.type, modifier: p.next.modifier, name: p.next.name, distance: p.next.distance, text: p.next.text, exit: p.next.exit } };
}
function routeMsg() { const n = phone.nav.state(); return { t: 'route', route: n && { dest: n.dest, coords: n.coords, steps: n.steps, distance: n.distance, duration: n.duration } }; }

/* ---------- screens: what each display shows ---------- */
const lcd = new Lcd(cfg);
const screens = new Screens(cfg, lcd);
screens.on('change', () => broadcast(screens.state()));
const X_ENV = { DISPLAY: ':0', XAUTHORITY: path.join(os.homedir(), '.Xauthority') };

/* ---------- the 3.5" SPI LCD on the header pins ---------- */
/** point its touch layer at the LCD's part of the X screen (after a layout, or a new calibration) */
function lcdTouch(cb) {
    const m = lcd.matrix();
    const done = (msg) => { if (msg) log('info', 'LCD touch: ' + msg); if (cb) cb(msg); };
    if (!m) return done('');
    const env = Object.assign({}, process.env, X_ENV);
    execFile('xinput', ['list', '--name-only'], { env, timeout: 4000 }, (err, out) => {
        if (err) return done('xinput not available');
        const devs = String(out).split('\n').map((l) => l.trim()).filter((l) => /ADS7846|XPT2046/i.test(l));
        if (!devs.length) return done('no ADS7846 touch device in X');
        let left = devs.length;
        devs.forEach((d) => execFile('xinput', ['set-prop', d, '--type=float', 'Coordinate Transformation Matrix', ...m.map(String)], { env, timeout: 4000 }, (e) => {
            if (e) log('warn', 'LCD touch: ' + d + ': ' + String(e.message).split('\n')[0]);
            if (--left === 0) done('mapped to ' + lcd.region.w + 'x' + lcd.region.h + '+' + lcd.region.x + '+' + lcd.region.y);
        }));
    });
}
function lcdInfo() { return Object.assign(lcd.state(), { screen: (screens.assignments().LCD || {}).screen || null }); }
function lcdRoot(args, cb) {
    execFile('sudo', ['-n', 'carhud-lcd', ...args], { timeout: 120000 }, (err, out, errOut) => {
        const text = (String(out || '') + String(errOut || '')).trim();
        cb(err ? (text || err.message) : null, text);
    });
}
function relayout(why, only) {
    log('info', 'screens: ' + why);
    runDetached('carhud-screens', only ? ['--only', only] : [], X_ENV);
}

/* ---------- audio output (the car's AUX through a USB sound card, the jack, HDMI) ---------- */
function audioInfo(cb) {
    execFile('carhud-audio', ['list', '--json'], { timeout: 5000 }, (err, out) => {
        let info = { available: false, outputs: [], choice: 'auto', current: null };
        if (!err) { try { info = Object.assign(JSON.parse(out), { available: true }); } catch (e) { /* bad output */ } }
        else info.error = /ENOENT/.test(err.code || err.message) ? 'carhud-audio is not installed (carhud update)' : String(err.message).split('\n')[0];
        execFile('carhud-audio', ['volume'], { timeout: 4000 }, (e2, v) => { info.volume = e2 ? null : parseInt(v, 10); cb(info); });
    });
}

/* ---------- sources ---------- */
function applySource() {
    if (state.source === 'demo') eva.setSignals('demo');
    else if (state.source === 'manual') eva.setSignals('manual', state.manual);
    else if (state.source === 'gps') eva.setSignals('manual', phone.hudValues());
    else {
        // the car: what it gives; standing still with the engine off until it answers
        const v = Object.assign({ rpm: 0, speed: 0, gear: 0 }, obd.state === 'live' ? obdHud : {});
        eva.setSignals('manual', v);
    }
}
function setSource(src, fromAuto) {
    if (src === 'auto') { state.auto = true; src = autoPick(); }
    else if (!fromAuto) state.auto = false;
    if (!['demo', 'manual', 'obd', 'gps'].includes(src)) return false;
    state.source = src;
    applySource();
    broadcastState();
    if (!fromAuto) log('info', 'source: ' + src);
    return true;
}
function stateMsg() {
    return {
        t: 'state', build: BUILD, version: VERSION, source: state.source, auto: state.auto, app: eva.state, drive: state.drive,
        manual: state.manual, obd: { state: obd.state, detail: obd.detail }, gps: phone.gpsFresh(), gearRatios: derive.ratios, gearRatiosSet: derive.ratiosConfigured,
    };
}
function broadcastState() { broadcast(stateMsg()); }

/* values for the panels, 4 times a second */
setInterval(() => {
    if (!dataClients.size) return;
    broadcast({ t: 'values', source: state.source, hud: eva.values, obd: obd.values, derived: obdHud, ratio: derive.ratio }, (c) => c.wantsData);
}, 250);
setInterval(() => {
    if (!dataClients.size) return;
    broadcast({ t: 'obd', snap: obd.snapshot() }, (c) => c.wantsData);
    broadcast({ t: 'stats', streams: streamer.stats(), clients: dataClients.size, mem: Math.round(process.memoryUsage().rss / 1048576) }, (c) => c.wantsLog);
}, 1000);

/* ---------- HTTP ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/svg+xml', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska' };
const MEDIA_EXT = /\.(mp3|m4a|aac|ogg|flac|wav|mp4|webm|mkv)$/i;

function isLocal(req) { const a = req.socket.remoteAddress || ''; return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'; }

/** A file under base, or null (no ../ escapes). */
function safeJoin(base, rel) {
    const p = path.normalize(path.join(base, decodeURIComponent(rel)));
    return p === base || p.startsWith(base + path.sep) ? p : null;
}

function sendFile(req, res, file, cache) {
    fs.stat(file, (err, st) => {
        if (!err && st.isDirectory()) return sendFile(req, res, path.join(file, 'index.html'), cache);
        if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
        const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
        const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        const headers = { 'content-type': type, 'cache-control': cache ? 'max-age=3600' : 'no-cache', 'accept-ranges': 'bytes' };
        if (range) {
            const start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
            const end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
            if (start >= st.size || start > end) { res.writeHead(416, { 'content-range': 'bytes */' + st.size }); return res.end(); }
            res.writeHead(206, Object.assign(headers, { 'content-range': 'bytes ' + start + '-' + end + '/' + st.size, 'content-length': end - start + 1 }));
            return fs.createReadStream(file, { start, end }).pipe(res);
        }
        res.writeHead(200, Object.assign(headers, { 'content-length': st.size }));
        fs.createReadStream(file).pipe(res);
    });
}

function json(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); }
function body(req) {
    return new Promise((resolve) => {
        let s = '';
        req.on('data', (d) => { s += d; if (s.length > 1e5) req.destroy(); });
        req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch (e) { resolve({}); } });
    });
}

/* desk apps: the built-in ones, then the user's own folder (kept across updates) */
function deskApps() {
    const out = [];
    const scan = (dir, urlBase, builtin) => {
        let ids = []; try { ids = fs.readdirSync(dir); } catch (e) { return; }
        ids.forEach((id) => {
            let m; try { m = JSON.parse(fs.readFileSync(path.join(dir, id, 'app.json'), 'utf8')); } catch (e) { return; }
            let url = m.type === 'url' ? String(m.url || '').replace(/\$\{([A-Z_]+)\}/g, (x, k) => cfg[k] || '') : urlBase + id + '/' + (m.entry || 'index.html');
            if (!url || m.hidden) return;
            const icon = m.icon && /\.(png|svg|jpg)$/.test(m.icon) ? urlBase + id + '/' + m.icon : (m.icon || '■');
            out.push({ id, name: m.name || id, icon, url, order: m.order === undefined ? 50 : m.order, builtin, color: m.color || null });
        });
    };
    scan(path.join(ROOT, 'desk', 'apps'), '/desk/apps/', true);
    scan(cfg.USER_APPS_DIR, '/user-apps/', false);
    const seen = new Set();
    return out.reverse().filter((a) => !seen.has(a.id) && seen.add(a.id)).reverse().sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

function mediaList() {
    const base = cfg.MEDIA_DIR, out = [];
    const walk = (dir, depth) => {
        if (depth > 4 || out.length > 3000) return;
        let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        ents.sort((a, b) => a.name.localeCompare(b.name)).forEach((e) => {
            if (e.name[0] === '.') return;
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p, depth + 1);
            else if (MEDIA_EXT.test(e.name)) out.push(path.relative(base, p));
        });
    };
    walk(base, 0);
    return { dir: base, files: out };
}

function systemInfo(cb) {
    const ifs = os.networkInterfaces(), ips = [];
    Object.keys(ifs).forEach((n) => ifs[n].forEach((a) => { if (a.family === 'IPv4' && !a.internal) ips.push({ iface: n, ip: a.address }); }));
    let temp = null; try { temp = Number(fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8')) / 1000; } catch (e) { /* not a Pi */ }
    let evaRef = '?'; try { evaRef = gitHead(cfg.EVA_DIR); } catch (e) { /* none */ }
    const info = {
        hostname: os.hostname(), ips, port: cfg.port, version: VERSION, commit: gitHead(ROOT), evaCommit: evaRef, node: process.version,
        uptime: os.uptime(), load: os.loadavg(), memTotal: os.totalmem(), memFree: os.freemem(), temp, throttled: null, config: cfg.file,
    };
    execFile('nmcli', ['-t', '-f', 'NAME,TYPE,DEVICE', 'connection', 'show', '--active'], { timeout: 3000 }, (e2, out2) => {
        if (!e2) {
            const w = String(out2).split('\n').map((l) => l.split(':')).find((f) => /wireless/.test(f[1] || ''));
            info.wifi = w ? { connection: w[0], hotspot: w[0] === 'carhud-ap' } : { connection: null, hotspot: false };
        }
        // the hostapd hotspot (carhud-wifi) isn't a NetworkManager connection: it leaves its name here
        try { const ap = fs.readFileSync('/run/carhud/hotspot', 'utf8').trim(); if (ap) info.wifi = { connection: ap, hotspot: true }; } catch (e) { /* off */ }
        sysDone();
    });
    let pending = 2;
    const sysDone = () => { if (--pending === 0) cb(info); };
    execFile('vcgencmd', ['get_throttled'], { timeout: 2000 }, (err, out) => {
        if (!err) {
            const v = parseInt(String(out).split('=')[1], 16);
            if (isFinite(v)) info.throttled = { raw: '0x' + v.toString(16), underVoltageNow: !!(v & 1), throttledNow: !!(v & 4), underVoltageSinceBoot: !!(v & 0x10000), throttledSinceBoot: !!(v & 0x40000) };
        }
        sysDone();
    });
}

function runDetached(cmd, args, env) {
    const p = spawn(cmd, args, { detached: true, stdio: 'ignore', env: Object.assign({}, process.env, env || {}) });
    p.on('error', (e) => log('error', cmd + ': ' + e.message));
    p.unref();
}

const UPDATE_LOG = path.join(os.tmpdir(), 'carhud-update.log');
const routes = {
    'GET /api/state': (req, res) => json(res, 200, stateMsg()),
    'GET /api/values': (req, res) => json(res, 200, { source: state.source, hud: eva.values, obd: obd.values, derived: obdHud, ratio: derive.ratio }),
    'GET /api/obd': (req, res) => json(res, 200, obd.snapshot()),
    /* learning the gear ratios by driving (carhud gears learn) */
    'GET /api/obd/gears': (req, res) => json(res, 200, derive.learning()),
    'POST /api/obd/gears': async (req, res) => {
        const b = await body(req);
        try {
            if (b.action === 'learn') { log('info', 'gears: learning started'); return json(res, 200, derive.learn(true)); }
            if (b.action === 'stop') return json(res, 200, derive.learn(false));
            if (b.action === 'save') { const r = derive.saveLearned(); log('info', 'gears: learned ' + r.join(', ') + ' rpm per km/h'); broadcast(stateMsg()); return json(res, 200, derive.learning()); }
            if (b.action === 'pedal-reset') { derive.resetPedal(); log('info', 'pedal: rest and flat-out positions forgotten'); return json(res, 200, {}); }
            if (b.action === 'reset') { derive.forgetLearned(); log('info', 'gears: learned ratios forgotten (' + derive.ratiosFrom + ' now)'); broadcast(stateMsg()); return json(res, 200, derive.learning()); }
        } catch (e) { return json(res, 400, { error: e.message }); }
        json(res, 400, { error: 'action: learn | stop | save | reset' });
    },
    'GET /api/settings': (req, res) => json(res, 200, eva.settings || {}),
    'GET /api/logs': (req, res) => json(res, 200, logs),
    'GET /api/desk/apps': (req, res) => json(res, 200, { apps: deskApps(), home: cfg.DESK_HOME }),
    'GET /api/media': (req, res) => json(res, 200, mediaList()),
    'GET /api/system': (req, res) => systemInfo((i) => json(res, 200, i)),
    'GET /api/system/update-log': (req, res) => fs.readFile(UPDATE_LOG, 'utf8', (e, s) => json(res, 200, { log: e ? '' : s })),
    'POST /api/source': async (req, res) => { const b = await body(req); json(res, setSource(b.source) ? 200 : 400, stateMsg()); },
    'POST /api/hold': (req, res) => {
        const v = eva.values || {};
        Object.keys(MANUAL_DEFAULTS).forEach((k) => { if (typeof v[k] === 'number') state.manual[k] = Math.round(v[k] * 100) / 100; });
        save(); setSource('manual'); log('info', 'hold: froze the current values in manual');
        json(res, 200, stateMsg());
    },
    'POST /api/manual': async (req, res) => {
        const b = await body(req);
        if (b.reset) state.manual = Object.assign({}, MANUAL_DEFAULTS);
        Object.keys(b.values || {}).forEach((k) => { const n = Number(b.values[k]); if (isFinite(n)) state.manual[k] = n; });
        save();
        if (b.switch !== false && state.source !== 'manual') setSource('manual'); else { applySource(); broadcastState(); }
        json(res, 200, stateMsg());
    },
    'POST /api/drive': async (req, res) => {
        const b = await body(req);
        state.drive = b.value === null || b.value === undefined || b.value === '' ? null : Number(b.value);
        eva.setDrive(state.drive); save(); broadcastState();
        log('info', 'drive mode: ' + (state.drive === null ? 'not sent' : state.drive));
        json(res, 200, stateMsg());
    },
    'POST /api/setting': async (req, res) => {
        const b = await body(req);
        if (eva.state !== 'running') return json(res, 409, { error: 'HUD app not running' });
        eva.setSetting(b.key, b.value); log('info', 'setting ' + b.key + ' = ' + JSON.stringify(b.value));
        json(res, 200, { ok: true });
    },
    'POST /api/app/restart': async (req, res) => { const b = await body(req); json(res, 200, { ok: true }); eva.restart(b.rebuild ? 'rebuild requested' : 'restart requested', !!b.rebuild); },
    'POST /api/obd/reconnect': (req, res) => { obd.reconnect(); json(res, 200, { ok: true }); },
    'GET /api/phone': (req, res) => json(res, 200, Object.assign(phone.state(), { route: routeMsg().route, config: phoneConfig() })),
    'POST /api/phone/discoverable': async (req, res) => {
        const b = await body(req);
        if (!cfg.on('PHONE_BLUETOOTH')) return json(res, 503, { error: 'Bluetooth is off in the settings (PHONE_BLUETOOTH=0)' });
        if (!phone.send({ t: 'discoverable', on: b.on !== false, seconds: Number(b.seconds) || 180 })) return json(res, 503, { error: "Bluetooth isn't running on the Pi: " + (phone.bt.error || 'starting up') });
        if (!phone.bt.adapter) return json(res, 503, { error: 'No Bluetooth adapter found on the Pi' + (phone.bt.error ? ': ' + phone.bt.error : '') + '. Try: carhud phone --check' });
        json(res, 200, { ok: true, name: phone.bt.adapter.name });
    },
    'POST /api/phone/pair': async (req, res) => { const b = await body(req); json(res, phone.send({ t: 'pair-reply', accept: !!b.accept }) ? 200 : 503, {}); },
    'POST /api/phone/media': async (req, res) => { const b = await body(req); json(res, phone.send({ t: 'media', action: String(b.action) }) ? 200 : 503, {}); },
    'POST /api/phone/volume': async (req, res) => { const b = await body(req); json(res, phone.send({ t: 'volume', value: Number(b.value) }) ? 200 : 503, {}); },
    'POST /api/phone/connect': async (req, res) => { const b = await body(req); json(res, phone.send({ t: 'connect', address: b.address }) ? 200 : 503, {}); },
    'POST /api/phone/disconnect': async (req, res) => { const b = await body(req); json(res, phone.send({ t: 'disconnect', address: b.address }) ? 200 : 503, {}); },
    'POST /api/phone/forget': async (req, res) => { const b = await body(req); json(res, phone.send({ t: 'forget', address: b.address }) ? 200 : 503, {}); },
    'POST /api/phone/notification': async (req, res) => { const b = await body(req); json(res, phone.send({ t: 'notif-action', uid: b.uid, positive: !!b.positive }) ? 200 : 503, {}); },
    'POST /api/phone/notifications/clear': (req, res) => { phone.notifications = []; phone.changed(); json(res, 200, {}); },
    'POST /api/phone/gps': async (req, res) => { const b = await body(req); json(res, phone.fix(b) ? 200 : 400, {}); },
    'POST /api/phone/route': async (req, res) => {
        const b = await body(req);
        try { phone.setRoute(b.route); broadcast(routeMsg(), (c) => c.wantsData); json(res, 200, { ok: true }); } catch (e) { json(res, 400, { error: e.message }); }
    },
    'POST /api/phone/route/clear': (req, res) => { phone.clearRoute(); broadcast(routeMsg(), (c) => c.wantsData); json(res, 200, {}); },
    'POST /api/phone/simulate': async (req, res) => { const b = await body(req); json(res, 200, { simulating: phone.simulate(b.speed) }); },
    'GET /api/phone/config': (req, res) => json(res, 200, phoneConfig()),
    /* testing without a phone: a pretend notification (or call) on the desk */
    'POST /api/phone/test-notification': async (req, res) => {
        const b = await body(req), call = b.call === true, uid = 900000 + Math.floor(Math.random() * 99999);
        setTimeout(() => phone._msg({ t: 'notification-removed', uid }), 20000);
        phone._msg({ t: 'notification', uid, category: call ? 'incoming-call' : 'social',
            appName: call ? 'Phone' : 'Messages', app: 'test', title: call ? 'Test caller' : 'Test message', message: call ? 'Incoming call' : 'This is how a notification looks on the desk.',
            positive: call ? 'Answer' : '', negative: call ? 'Decline' : '', hasPositive: call, hasNegative: call, preexisting: false, silent: false });
        json(res, 200, {});
    },
    'POST /api/displays/reload': (req, res) => { broadcast({ t: 'reload' }); displays.forEach((d) => d.send({ t: 'reload' })); json(res, 200, { ok: true }); },
    'POST /api/system/screens': (req, res) => {
        runDetached('carhud-screens', [], { DISPLAY: ':0', XAUTHORITY: path.join(os.homedir(), '.Xauthority') });
        json(res, 200, { ok: true });
    },
    'POST /api/system/restart': (req, res) => { json(res, 200, { ok: true }); setTimeout(() => runDetached('sudo', ['-n', 'systemctl', 'restart', 'carhud']), 200); },
    'GET /api/screens': (req, res) => screens.refresh(() => json(res, 200, screens.state())),
    'GET /api/screens/layout': (req, res) => screens.refresh(() => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(screens.layoutText()); }),
    'POST /api/screens': async (req, res) => {
        const b = await body(req);
        let needs;
        try { needs = screens.set(b.output, b); } catch (e) { return json(res, 400, { error: e.message }); }
        const a = screens.assignments()[b.output];
        if (needs === 'layout') relayout(b.output + ' → ' + a.screen + (a.rotate !== 'normal' ? ', rotated ' + a.rotate : '') + ': redoing the layout');
        else if (needs === 'window') relayout(b.output + ' → ' + a.screen, b.output);
        else log('info', 'screens: ' + b.output + ' → ' + a.screen);
        json(res, 200, screens.state());
    },
    'POST /api/screens/identify': (req, res) => { broadcast({ t: 'identify', until: Date.now() + 5000 }); json(res, 200, {}); },
    'POST /api/screens/relayout': (req, res) => { relayout('layout requested'); json(res, 200, {}); },
    'GET /api/lcd': (req, res) => json(res, 200, lcdInfo()),
    /* carhud-screens tells where it put the LCD's area of the X screen: x y w h and the whole screen's size */
    'POST /api/lcd/region': async (req, res) => {
        const b = await body(req), r = {};
        for (const k of ['x', 'y', 'w', 'h', 'sw', 'sh']) { r[k] = Number(b[k]); if (!isFinite(r[k]) || (k !== 'x' && k !== 'y' && r[k] <= 0)) return json(res, 400, { error: 'bad ' + k }); }
        lcd.setRegion(r);
        screens.refresh();
        lcdTouch(() => json(res, 200, lcdInfo()));
    },
    'POST /api/lcd/setup': async (req, res) => {
        const b = await body(req), args = ['setup', String(b.model || '')];
        if (b.rotate !== undefined) args.push(String(Number(b.rotate)));
        lcdRoot(args, (err, text) => {
            if (err) return json(res, 400, { error: err.split('\n').slice(-3).join(' ') });
            cfg.LCD_MODEL = String(b.model); if (b.rotate !== undefined) cfg.LCD_ROTATE = String(Number(b.rotate));
            log('info', 'LCD: set up ' + b.model + ', reboot to start it');
            json(res, 200, Object.assign(lcdInfo(), { result: text, reboot: true }));
        });
    },
    'POST /api/lcd/off': (req, res) => lcdRoot(['off'], (err, text) => {
        if (err) return json(res, 400, { error: err });
        cfg.LCD_MODEL = ''; log('info', 'LCD: turned off, reboot to finish');
        json(res, 200, Object.assign(lcdInfo(), { result: text, reboot: true }));
    }),
    'POST /api/lcd/test': (req, res) => execFile('carhud-lcd', ['test'], { timeout: 15000 }, (err, out) => json(res, err ? 400 : 200, { result: String(out || (err && err.message) || '').trim() })),
    /* touch calibration: the LCD shows four targets; the taps come back here */
    'POST /api/lcd/calibrate': (req, res) => { broadcast({ t: 'lcd-calibrate' }); json(res, 200, {}); },
    'POST /api/lcd/calibration': async (req, res) => {
        const b = await body(req);
        try { lcd.calibrate(b.points); } catch (e) { return json(res, 400, { error: e.message }); }
        log('info', 'LCD touch calibrated from ' + b.points.length + ' taps');
        lcdTouch(() => json(res, 200, lcdInfo()));
    },
    'POST /api/lcd/calibration/reset': (req, res) => { lcd.resetCalibration(); lcdTouch(() => json(res, 200, lcdInfo())); },
    'GET /api/audio': (req, res) => audioInfo((i) => json(res, 200, i)),
    'POST /api/audio': async (req, res) => {
        const b = await body(req);
        execFile('sudo', ['-n', 'carhud-audio', 'set', String(b.output || 'auto')], { timeout: 15000 }, (err, out, errOut) => {
            const msg = String(out || '').trim().split('\n').pop();
            if (err) return json(res, 400, { error: (String(errOut || '').trim() || msg || err.message).split('\n').slice(-1)[0] });
            log('info', 'audio: ' + msg);
            audioInfo((i) => json(res, 200, i));
        });
    },
    'POST /api/audio/test': (req, res) => { execFile('carhud-audio', ['test'], { timeout: 8000 }, (err, out) => json(res, err ? 400 : 200, { result: String(out || err && err.message).trim() })); },
    'POST /api/audio/volume': async (req, res) => {
        const b = await body(req);
        execFile('carhud-audio', ['volume', String(Math.max(0, Math.min(100, Number(b.value) || 0)))], { timeout: 4000 }, (err, out) => json(res, err ? 400 : 200, err ? { error: String(out || err.message).trim() } : { volume: parseInt(out, 10) }));
    },
    'POST /api/system/wifi': async (req, res) => {
        const b = await body(req);
        // hotspot on now, or off (the Pi then joins a known Wi-Fi network by itself)
        const args = ['-n', '/usr/local/bin/carhud-wifi', b.mode === 'ap' ? 'hotspot' : 'home'];
        json(res, 200, { ok: true });
        setTimeout(() => runDetached('sudo', args), 300);
        log('info', 'Wi-Fi: ' + (b.mode === 'ap' ? 'switching to the hotspot' : 'leaving the hotspot'));
    },
    'POST /api/system/reboot': (req, res) => { json(res, 200, { ok: true }); setTimeout(() => runDetached('sudo', ['-n', 'systemctl', 'reboot']), 500); },
    'POST /api/system/update': (req, res) => {
        fs.writeFileSync(UPDATE_LOG, 'Starting update...\n');
        // run outside this service, so restarting the service at the end does not cut the update off
        runDetached('sudo', ['-n', 'systemd-run', '--collect', '--quiet', '--uid=' + os.userInfo().username, '--setenv=HOME=' + os.homedir(),
            '/bin/sh', '-c', 'exec /usr/local/bin/carhud update > ' + UPDATE_LOG + ' 2>&1']);
        json(res, 200, { ok: true, log: UPDATE_LOG });
    },
};
const SYSTEM_ACTIONS = /^POST \/api\/(system\/|lcd\/(setup|off)$)/;
function phoneConfig() {
    return { name: cfg.PHONE_NAME, httpsPort: tlsOk ? Number(cfg.PHONE_HTTPS_PORT) : null, httpPort: cfg.port,
        geocoder: cfg.PHONE_GEOCODER_URL, router: cfg.PHONE_ROUTER_URL, hostname: os.hostname(),
        ap: cfg.PHONE_AP, apSsid: cfg.PHONE_AP_SSID, apPassword: cfg.PHONE_AP_PASSWORD };
}

const displays = new Set();
const handler = async (req, res) => {
    if (!cfg.on('ALLOW_LAN') && !isLocal(req)) { res.writeHead(403); return res.end('LAN access is off (ALLOW_LAN=0)'); }
    const url = req.url.split('?')[0];
    const key = req.method + ' ' + url;
    try {
        if (routes[key]) {
            if (SYSTEM_ACTIONS.test(key) && !isLocal(req) && !cfg.on('ALLOW_LAN_SYSTEM') && !['POST /api/system/screens'].includes(key)) {
                return json(res, 403, { error: 'system actions are only allowed on the Pi itself (set ALLOW_LAN_SYSTEM=1 to allow)' });
            }
            return await routes[key](req, res);
        }
        if (req.method !== 'GET') { res.writeHead(404); return res.end(); }
        // a phone opening the plain address (e.g. http://10.42.0.1 on the car hotspot) lands on the phone app
        if (url === '/' && /iPhone|Android.+Mobile|Mobile Safari/.test(req.headers['user-agent'] || '') && !/[?&]panel/.test(req.url)) {
            res.writeHead(302, { location: '/phone/' }); return res.end();
        }
        if (url === '/favicon.ico') { res.writeHead(301, { location: '/favicon.svg' }); return res.end(); }
        if (url === '/') return sendFile(req, res, path.join(ROOT, 'web', 'index.html'));
        if (url === '/hud') return sendFile(req, res, path.join(ROOT, 'web', 'hud.html'));
        if (url === '/screen') return sendFile(req, res, path.join(ROOT, 'web', 'screen.html'));
        if (url === '/debug') return sendFile(req, res, path.join(ROOT, 'web', 'debug.html'));
        if (url === '/lcd-calibrate') return sendFile(req, res, path.join(ROOT, 'web', 'lcd-calibrate.html'));
        if (url === '/display') return sendFile(req, res, path.join(ROOT, 'web', 'display.html'));
        if (url === '/phone') { res.writeHead(302, { location: '/phone/' }); return res.end(); }
        if (url === '/phone/carhud-ca.crt') {
            res.setHeader('content-disposition', 'attachment; filename="carhud-ca.crt"');
            return fs.readFile(path.join(cfg.PHONE_TLS_DIR, 'ca.crt'), (e, b) => { if (e) { res.writeHead(404); return res.end('no certificate yet: run the installer'); } res.writeHead(200, { 'content-type': 'application/x-x509-ca-cert' }); res.end(b); });
        }
        if (url === '/desk' ) { res.writeHead(302, { location: '/desk/' }); return res.end(); }
        if (url === '/desk/') return sendFile(req, res, path.join(ROOT, 'desk', 'index.html'));
        const pick = (prefix, base) => url.startsWith(prefix) && safeJoin(base, url.slice(prefix.length));
        let f;
        if ((f = pick('/desk/', path.join(ROOT, 'desk')))) return sendFile(req, res, f);
        if ((f = pick('/user-apps/', cfg.USER_APPS_DIR))) return sendFile(req, res, f);
        if ((f = pick('/media/', cfg.MEDIA_DIR))) return sendFile(req, res, f, true);
        if ((f = pick('/', path.join(ROOT, 'web')))) return sendFile(req, res, f);
        res.writeHead(404); res.end('not found');
    } catch (e) {
        log('error', 'http ' + key + ': ' + e.message);
        if (!res.headersSent) json(res, 500, { error: e.message });
    }
};
const server = http.createServer(handler);
/* the phone web app is served over https too: browsers only give a page GPS on https */
let tlsServer = null, tlsOk = false;
try {
    const key = fs.readFileSync(path.join(cfg.PHONE_TLS_DIR, 'server.key')), cert = fs.readFileSync(path.join(cfg.PHONE_TLS_DIR, 'server.crt'));
    tlsServer = https.createServer({ key, cert }, handler);
    tlsOk = true;
} catch (e) { /* no certificate: http only */ }

const onWs = (c, req) => {
    if (!cfg.on('ALLOW_LAN') && !isLocal(req)) return c.close();
    const q = new URL(req.url, 'http://x').searchParams;
    c.addr = req.socket.remoteAddress;
    c.role = q.get('role') || (q.get('target') ? 'display' : 'panel');
    c.wantsData = q.get('data') !== '0';
    c.wantsLog = q.get('log') === '1';
    c.send({ t: 'hello', build: BUILD, version: VERSION, targets: TARGETS });
    c.send(stateMsg());
    c.on('message', (m) => {
        if (!m) return;
        if (m.t === 'ping') c.send({ t: 'pong', id: m.id, server: Date.now() });
        else if (m.t === 'gps') phone.fix(m);
    });
    dataClients.add(c);
    c.on('close', () => { dataClients.delete(c); displays.delete(c); });
    if (c.wantsData) {
        if (eva.settings) c.send(Object.assign({ t: 'settings' }, eva.settings));
        if (eva.status) c.send({ t: 'status', s: eva.status });
        c.send({ t: 'obd', snap: obd.snapshot() });
        c.send({ t: 'phone', phone: phone.state() });
        c.send(routeMsg());
    }
    c.send(navMsg());
    c.send(screens.state());
    if (c.wantsLog) logs.forEach((e) => c.send(e));
    const target = q.get('target');
    if (target && (TARGETS[target] || target === 'all')) { displays.add(c); streamer.add(c, target, Number(q.get('fps')) || 0); }
};
ws.attach(server, (u) => u.split('?')[0] === '/ws', onWs);
if (tlsServer) ws.attach(tlsServer, (u) => u.split('?')[0] === '/ws', onWs);

/* ---------- start ---------- */
renderer.listen(() => {
    server.listen(cfg.port, cfg.on('ALLOW_LAN') ? '0.0.0.0' : '127.0.0.1', () => {
        log('info', 'carhud ' + VERSION + ' on port ' + cfg.port + (cfg.on('ALLOW_LAN') ? ' (LAN on)' : ' (this Pi only)') + ', config ' + cfg.file);
        applySource();
        if (state.drive !== null) eva.setDrive(state.drive);
        eva.start();
        if (cfg.on('OBD_ENABLE')) obd.start(); else log('info', 'OBD off (OBD_ENABLE=0)');
        phone.start();
        // the plain address too (http://10.42.0.1, http://carhud.local): port 80 needs the service's
        // CAP_NET_BIND_SERVICE, which the installer gives it
        if (cfg.on('HTTP_PORT_80') && cfg.port !== 80) {
            const plain = http.createServer(handler);
            ws.attach(plain, (u) => u.split('?')[0] === '/ws', onWs);
            plain.on('error', (e) => log(e.code === 'EACCES' ? 'info' : 'warn', 'port 80 not available (' + e.code + '): use port ' + cfg.port));
            plain.listen(80, cfg.on('ALLOW_LAN') ? '0.0.0.0' : '127.0.0.1', () => log('info', 'also on port 80'));
        }
        if (tlsServer) {
            tlsServer.on('error', (e) => log('warn', 'https server: ' + e.message));
            tlsServer.listen(Number(cfg.PHONE_HTTPS_PORT), cfg.on('ALLOW_LAN') ? '0.0.0.0' : '127.0.0.1', () => log('info', 'phone app on https port ' + cfg.PHONE_HTTPS_PORT));
        } else log('info', 'no certificate in ' + cfg.PHONE_TLS_DIR + ': the phone app runs on http only (no GPS)');
    });
});
server.on('error', (e) => { log('error', 'http server: ' + e.message); process.exit(1); });

async function shutdown() {
    log('info', 'stopping');
    obd.stop();
    phone.stop();
    await eva.stop();
    renderer.close();
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
