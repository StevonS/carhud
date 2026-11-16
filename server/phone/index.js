'use strict';
/**
 * The phone link: Bluetooth (through bt_helper.py) and the phone web app (GPS, navigation).
 *
 * Events: 'change' (state for the screens), 'pair' (a phone wants to pair), 'notification',
 *         'notification-removed', 'gps' (fix), 'log' (level, text)
 */
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { Nav, bearing } = require('./nav');

class Phone extends EventEmitter {
    constructor(cfg) {
        super();
        this.cfg = cfg;
        this.bt = { available: false, adapter: null, devices: [], media: null, volume: null };
        this.pairing = null;
        this.notifications = [];
        this.gps = null;
        this.gpsPrev = null;
        this.gLat = 0; this.gLong = 0;
        this.nav = new Nav();
        this.child = null;
        this.backoff = 2000;
        this._changeTimer = null;
    }

    log(level, text) { this.emit('log', level, text); }
    changed() {
        if (this._changeTimer) return;
        this._changeTimer = setTimeout(() => { this._changeTimer = null; this.emit('change', this.state()); }, 60);
    }

    /* ---------- Bluetooth helper ---------- */
    start() {
        if (!this.cfg.on('PHONE_BLUETOOTH')) { this.log('info', 'bluetooth: off (PHONE_BLUETOOTH=0)'); return; }
        const env = Object.assign({}, process.env, {
            CARHUD_BT_NAME: this.cfg.PHONE_NAME, CARHUD_BT_ANCS: this.cfg.on('PHONE_NOTIFICATIONS') ? '1' : '0',
            CARHUD_BT_STATE: path.join(this.cfg.DATA_DIR, 'bluetooth.json'), CARHUD_BT_ADAPTER: this.cfg.PHONE_ADAPTER || '',
        });
        const c = spawn(this.cfg.PHONE_PYTHON || 'python3', ['-u', path.join(__dirname, 'bt_helper.py')], { stdio: ['pipe', 'pipe', 'pipe'], env });
        this.child = c;
        let rest = '', errText = '';
        c.stdout.on('data', (d) => {
            const lines = (rest + d).split('\n'); rest = lines.pop();
            lines.forEach((l) => { if (l.trim()) { try { this._msg(JSON.parse(l)); } catch (e) { this.log('warn', 'bluetooth helper said: ' + l.slice(0, 120)); } } });
        });
        c.stderr.on('data', (d) => { errText += d; if (errText.length > 4000) errText = errText.slice(-4000); });
        c.on('error', (e) => this.log('error', 'bluetooth helper: ' + e.message));
        c.on('exit', (code) => {
            if (c !== this.child) return;
            this.child = null;
            this.bt.available = false; this.changed();
            const why = /ModuleNotFoundError: No module named '(\w+)'/.exec(errText);
            if (why) this.log('error', 'bluetooth: python module "' + why[1] + '" missing (sudo apt install python3-dbus python3-gi), retrying in a minute');
            else this.log('warn', 'bluetooth helper stopped (code ' + code + ')' + (errText ? ': ' + errText.trim().split('\n').slice(-1)[0] : ''));
            errText = '';
            const wait = why ? 60000 : this.backoff;
            this.backoff = Math.min(this.backoff * 2, 60000);
            setTimeout(() => this.start(), wait);
        });
    }

    stop() { const c = this.child; this.child = null; if (c) c.kill(); this.nav.simulate(0); }

    send(m) { if (this.child) this.child.stdin.write(JSON.stringify(m) + '\n'); return !!this.child; }

    _msg(m) {
        switch (m.t) {
            case 'log': this.log(m.level, m.text); break;
            case 'state':
                this.backoff = 2000;
                Object.assign(this.bt, { available: true, adapter: m.adapter, devices: m.devices, media: m.media, volume: m.volume });
                this.changed();
                break;
            case 'pair-request': this.pairing = m; this.emit('pair', m); this.changed(); break;
            case 'pair-done': this.pairing = null; this.changed(); break;
            case 'notification': {
                const n = Object.assign({ at: Date.now() }, m); delete n.t;
                const i = this.notifications.findIndex((x) => x.uid === n.uid);
                if (i >= 0) this.notifications[i] = Object.assign(this.notifications[i], n);
                else { this.notifications.unshift(n); this.notifications.length = Math.min(this.notifications.length, 40); }
                if (!n.preexisting && !n.silent) this.emit('notification', n);
                this.changed();
                break;
            }
            case 'notification-removed':
                this.notifications = this.notifications.filter((x) => x.uid !== m.uid);
                this.emit('notification-removed', m.uid); this.changed();
                break;
            default: break;
        }
    }

    /* ---------- GPS from the phone (or the simulator) ---------- */
    fix(f) {
        const lat = Number(f.lat), lon = Number(f.lon);
        if (!isFinite(lat) || !isFinite(lon)) return false;
        const now = Date.now();
        // speed: from the phone (m/s -> km/h) when it gives one, otherwise from the distance moved
        let speed = f.speedKmh !== undefined ? Number(f.speedKmh) : (f.speed !== undefined && f.speed !== null && !f.sim ? Number(f.speed) * 3.6 : Number(f.speed));
        const prev = this.gps;
        if (!isFinite(speed) || speed < 0) speed = null;
        let heading = f.heading !== undefined && f.heading !== null && isFinite(f.heading) ? Number(f.heading) : null;
        if (prev && now - prev.at < 5000) {
            const dt = (now - prev.at) / 1000;
            if (speed === null && dt > 0.5) speed = Math.round(require('./nav').haversine([prev.lon, prev.lat], [lon, lat]) / dt * 3.6);
            if (heading === null && speed > 5) heading = bearing([prev.lon, prev.lat], [lon, lat]);
            if (dt > 0.2 && speed !== null && prev.speed !== null) {
                const a = (speed - prev.speed) / 3.6 / dt / 9.80665;
                if (Math.abs(a) < 2) this.gLong = 0.6 * this.gLong + 0.4 * a;
                if (heading !== null && prev.heading !== null && speed > 10) {
                    const dh = ((heading - prev.heading + 540) % 360) - 180;
                    const g = (speed / 3.6) * (dh * Math.PI / 180) / dt / 9.80665;
                    if (Math.abs(g) < 2) this.gLat = 0.6 * this.gLat + 0.4 * g;
                }
            }
        }
        this.gps = { lat, lon, speed, heading, accuracy: Number(f.accuracy) || null, at: now, sim: !!f.sim };
        if (this.nav.route) {
            const pr = this.nav.update({ lat, lon, speed: speed || 0, accuracy: this.gps.accuracy });
            if (pr && pr.arrived && !this.arrivedSaid) { this.arrivedSaid = true; this.log('info', 'navigation: arrived at ' + (this.nav.route.dest && this.nav.route.dest.name)); }
        }
        this.emit('gps', this.gps);
        this.changed();
        return true;
    }

    gpsFresh() { return !!(this.gps && Date.now() - this.gps.at < 4000); }

    /** HUD values while driving on GPS alone (no OBD): speed and G; gear isn't known, so 1 while moving. */
    hudValues() {
        const g = this.gps, sp = g && g.speed !== null ? g.speed : 0;
        if (!this.gpsFresh()) return { rpm: 0, speed: 0, gear: 0 };
        if (sp >= 3) this.stillSince = 0; else if (!this.stillSince) this.stillSince = Date.now();
        const parked = this.stillSince && Date.now() - this.stillSince > 3000;
        return { speed: Math.round(sp), rpm: 0, gear: parked ? 0 : 1, gLong: Math.round(this.gLong * 100) / 100, gLat: Math.round(this.gLat * 100) / 100 };
    }

    setRoute(r) {
        this.nav.set(r); this.arrivedSaid = false;
        if (this.gps) this.nav.update(this.gps);
        this.log('info', 'navigation: to ' + ((r.dest && r.dest.name) || 'destination') + ', ' + (this.nav.total / 1000).toFixed(1) + ' km');
        this.changed();
    }
    clearRoute() { this.nav.simulate(0); this.nav.clear(); this.log('info', 'navigation: ended'); this.changed(); }
    simulate(kmh) { const ok = this.nav.simulate(Number(kmh) || 0, (f) => this.fix(f)); this.changed(); return ok; }

    state() {
        const g = this.gps;
        return {
            bt: this.bt, pairing: this.pairing, notifications: this.notifications.slice(0, 20),
            gps: g ? Object.assign({ age: Date.now() - g.at, fresh: this.gpsFresh() }, g) : null,
            nav: this.nav.state(), simulating: this.nav.simulating,
        };
    }
}

module.exports = { Phone };
