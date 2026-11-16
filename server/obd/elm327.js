'use strict';
/**
 * Reads a car through an ELM327-compatible OBD-II adapter on USB (/dev/ttyUSB*, /dev/ttyACM*).
 * No native modules: the port is set up with stty and read through a `cat` child (easy to kill
 * when the cable is unplugged), written through a file descriptor.
 *
 * States: off -> searching (no adapter yet) -> connecting -> waiting (adapter OK, car not answering:
 * ignition off) -> live. Unplugging goes back to searching.
 *
 * Events: 'state' (state, detail), 'data' (values {name: number}), 'log' (level, text)
 */
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { EventEmitter } = require('events');
const { PIDS, hex2, supportedFrom } = require('./pids');

const BAUDS = [38400, 115200, 9600, 230400, 500000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The adapter's device: OBD_DEVICE, or the first USB serial port that looks like one. */
function findDevice(want) {
    if (want && want !== 'auto') return fs.existsSync(want) ? want : null;
    const byId = '/dev/serial/by-id';
    try {
        const ids = fs.readdirSync(byId).map((f) => path.join(byId, f));
        const pick = ids.find((p) => /obd|elm|obdlink|vlink|scan/i.test(p)) || ids.find((p) => /ftdi|ch34|cp210|pl2303|prolific|usb-serial|uart/i.test(p)) || ids[0];
        if (pick) return pick;
    } catch (e) { /* no by-id dir */ }
    try {
        const tty = fs.readdirSync('/dev').filter((f) => /^tty(USB|ACM)\d+$/.test(f)).sort();
        if (tty.length) return '/dev/' + tty[0];
    } catch (e) { /* none */ }
    return null;
}

class Port extends EventEmitter {
    open(dev, baud) {
        this.dev = dev;
        // hold the device open so the settings below stay applied while `cat` reads it
        this.fd = fs.openSync(dev, fs.constants.O_RDWR | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK);
        const args = ['-F', dev, 'raw', '-echo', '-echoe', '-echok', '-echoctl', '-echoke', 'cs8', '-cstopb', '-parenb', 'clocal', '-crtscts', '-ixon', '-ixoff', 'min', '1', 'time', '0'];
        if (baud) args.splice(2, 0, String(baud));
        execFileSync('stty', args, { stdio: 'ignore' });
        this.cat = spawn('cat', [dev], { stdio: ['ignore', 'pipe', 'ignore'] });
        this.cat.stdout.on('data', (d) => this.emit('data', d));
        this.cat.on('exit', () => { this.cat = null; this.emit('gone'); });
    }
    write(s) { fs.writeSync(this.fd, s); }
    close() {
        if (this.cat) { this.cat.removeAllListeners('exit'); this.cat.kill('SIGKILL'); this.cat = null; }
        if (this.fd !== undefined) { try { fs.closeSync(this.fd); } catch (e) { /* gone */ } this.fd = undefined; }
    }
}

class Elm327 extends EventEmitter {
    constructor(cfg) {
        super();
        this.cfg = cfg;
        this.state = 'off';
        this.detail = '';
        this.info = {};
        this.values = {};
        this.stamps = {};
        this.rates = {};
        this.supported = [];
        this.multi = cfg.OBD_MULTI !== '0';
        this.port = null;
        this.rx = '';
        this.waiter = null;
        this.round = 0;
        this.roundHz = 0;
        this.noData = {};
        this.stopped = false;
    }

    log(level, text) { this.emit('log', level, 'obd: ' + text); }
    _setState(s, detail) {
        if (s === this.state && detail === this.detail) return;
        this.state = s; this.detail = detail || '';
        this.log('info', s + (detail ? ' (' + detail + ')' : ''));
        this.emit('state', s, this.detail);
    }

    start() { this.stopped = false; this._loop(); }
    stop() { this.stopped = true; this._closePort(); this._setState('off'); }
    reconnect() { this.log('info', 'reconnect requested'); this._closePort(); }

    _closePort() { if (this.port) { this.port.close(); this.port = null; } if (this.waiter) { this.waiter.reject(new Error('port closed')); this.waiter = null; } }

    /** One command: resolves with the answer lines once the adapter prints its '>' prompt. */
    cmd(c, timeout) {
        return new Promise((resolve, reject) => {
            if (!this.port) return reject(new Error('no port'));
            if (this.waiter) return reject(new Error('busy'));
            this.rx = '';
            const t = setTimeout(() => { this.waiter = null; reject(new Error('timeout: ' + c)); }, timeout || 1500);
            this.waiter = {
                resolve: (txt) => { clearTimeout(t); resolve(txt.split(/[\r\n]+/).map((s) => s.trim()).filter((s) => s && s !== c && !/^SEARCHING/.test(s) && !/^BUS INIT/.test(s))); },
                reject: (e) => { clearTimeout(t); reject(e); },
            };
            try { this.port.write(c + '\r'); } catch (e) { this.waiter = null; clearTimeout(t); reject(e); }
        });
    }

    _onData(d) {
        this.rx += d.toString('latin1');
        const i = this.rx.indexOf('>');
        if (i >= 0 && this.waiter) {
            const w = this.waiter; this.waiter = null;
            const txt = this.rx.slice(0, i); this.rx = this.rx.slice(i + 1);
            w.resolve(txt.replace(/\0/g, ''));
        }
    }

    _open(dev, baud) {
        this._closePort();
        const p = new Port();
        p.on('data', (d) => this._onData(d));
        p.on('gone', () => { if (this.port === p) { this.log('warn', 'adapter connection lost'); this._closePort(); } });
        p.open(dev, baud);
        this.port = p;
    }

    async _probe(dev) {
        const bauds = this.cfg.OBD_BAUD && this.cfg.OBD_BAUD !== 'auto' ? [Number(this.cfg.OBD_BAUD)] : (/ttyACM/.test(fs.realpathSync(dev)) ? [0] : BAUDS);
        for (const b of bauds) {
            try {
                this._open(dev, b);
                await sleep(200);
                this.port.write('\r');
                await sleep(300);
                this.rx = '';
                const r = (await this.cmd('ATI', 1500)).join(' ');
                if (/ELM|OBD|STN|v\d\.\d/i.test(r)) { this.info.baud = b || 'usb'; this.info.version = r; return true; }
            } catch (e) { /* wrong speed: try the next */ }
        }
        this._closePort();
        return false;
    }

    async _init() {
        await this.cmd('ATZ', 4000).catch(() => {});
        await sleep(500);
        for (const c of ['ATE0', 'ATL0', 'ATS0', 'ATH0', 'ATAT2', 'ATST64', 'ATSP' + (this.cfg.OBD_PROTOCOL || '0')]) {
            await this.cmd(c, 1500).catch(() => {});
        }
        const v = await this.cmd('ATRV', 1500).catch(() => []);
        this.info.volts = parseFloat(v[0]) || null;
    }

    /** 0100: the first request makes the adapter find the car's protocol. True once the engine unit answers. */
    async _connectCar() {
        const r = await this.cmd('0100', 15000).catch((e) => [e.message]);
        const line = r.join('');
        if (!/41\s?00/i.test(line.replace(/\s/g, ''))) { this.info.lastError = r.join(' '); return false; }
        const dp = await this.cmd('ATDPN', 1500).catch(() => ['?']);
        const proto = (dp[0] || '').replace(/^A/, '');
        const desc = await this.cmd('ATDP', 1500).catch(() => ['?']);
        this.info.protocol = desc[0];
        this.info.can = /^[6-9A-C]$/i.test(proto);
        if (!this.info.can) this.multi = false;
        // supported PIDs, 0x01-0xA0
        let sup = [];
        for (let base = 0; base <= 0x80; base += 0x20) {
            const rr = await this.cmd('01' + hex2(base), 3000).catch(() => []);
            const bytes = this._bytesFor(rr, base, 4);
            if (!bytes) break;
            const s = supportedFrom(base, bytes);
            sup = sup.concat(s);
            if (s.indexOf(base + 0x20) < 0) break;
        }
        this.supported = sup;
        this.log('info', 'car answers on ' + this.info.protocol + ', ' + sup.filter((p) => PIDS[p]).length + ' useful PIDs');
        return true;
    }

    /** The data bytes of a one-PID answer (41 PID ...), or null. */
    _bytesFor(lines, pid, n) {
        const hex = this._joinFrames(lines);
        for (const h of hex) {
            const i = h.indexOf('41' + hex2(pid));
            if (i < 0) continue;
            const bytes = [];
            for (let j = i + 4; j + 2 <= h.length && bytes.length < n; j += 2) bytes.push(parseInt(h.substr(j, 2), 16));
            if (bytes.length === n) return bytes;
        }
        return null;
    }

    /** Answer lines -> one hex string per answer, multi-frame (CAN 0:, 1:, ...) put back together. */
    _joinFrames(lines) {
        const clean = lines.map((l) => l.replace(/\s/g, '').toUpperCase()).filter((l) => /^[0-9A-F:]+$/.test(l));
        if (clean.some((l) => /^[0-9A-F]:/.test(l))) {
            let total = null, s = '';
            clean.forEach((l) => {
                if (/^[0-9A-F]{3}$/.test(l)) total = parseInt(l, 16);
                else if (/^[0-9A-F]:/.test(l)) s += l.slice(2);
            });
            return [total ? s.slice(0, total * 2) : s];
        }
        return clean;
    }

    /** Several PIDs' answers in one: 41 pid data pid data ... */
    _parseMulti(lines, pids) {
        const out = {};
        this._joinFrames(lines).forEach((h) => {
            if (h.slice(0, 2) !== '41') return;
            let i = 2;
            while (i + 2 <= h.length) {
                const pid = parseInt(h.substr(i, 2), 16), def = PIDS[pid];
                if (!def || pids.indexOf(pid) < 0) break;
                const bytes = [];
                for (let k = 0; k < def.bytes; k++) bytes.push(parseInt(h.substr(i + 2 + k * 2, 2), 16));
                if (bytes.some((b) => isNaN(b))) break;
                out[pid] = bytes;
                i += 2 + def.bytes * 2;
            }
        });
        return out;
    }

    _plan() {
        const has = (p) => this.supported.indexOf(p) >= 0 && (this.noData[p] || 0) < 3;
        const r = this.round;
        const list = Object.keys(PIDS).map(Number).filter((p) => has(p) && (PIDS[p].tier === 1 || (PIDS[p].tier === 2 && r % 3 === 0) || (PIDS[p].tier === 3 && r % 12 === 0)));
        const drop = [];
        if (list.indexOf(0x87) >= 0) drop.push(0x0B);       // the wide-range MAP wins
        if (list.indexOf(0x24) >= 0) drop.push(0x34);
        return list.filter((p) => drop.indexOf(p) < 0);
    }

    _store(pid, bytes, now) {
        const def = PIDS[pid];
        const v = def.decode.apply(null, bytes);
        if (typeof v !== 'number' || !isFinite(v)) return;
        const prev = this.stamps[def.name];
        if (prev) this.rates[def.name] = 0.8 * (this.rates[def.name] || 0) + 0.2 * (1000 / Math.max(1, now - prev));
        this.values[def.name] = Math.round(v * 100) / 100;
        this.stamps[def.name] = now;
        this.noData[pid] = 0;
    }

    async _poll() {
        let errors = 0, t0 = Date.now(), n0 = 0;
        while (this.port && !this.stopped) {
            const pids = this._plan();
            const groups = [];
            if (this.multi) for (let i = 0; i < pids.length; i += 6) groups.push(pids.slice(i, i + 6));
            else pids.forEach((p) => groups.push([p]));
            for (const g of groups) {
                if (!this.port) return;
                const req = '01' + g.map(hex2).join('');
                let lines;
                try { lines = await this.cmd(req, 1000); } catch (e) { if (!this.port) return; lines = [e.message]; }
                const now = Date.now();
                const joined = lines.join(' ');
                if (/UNABLE TO CONNECT|CAN ERROR|BUS ERROR|BUS BUSY|ERROR|timeout/i.test(joined)) {
                    if (++errors >= 5) { this.info.lastError = joined; return 'lost'; }
                    continue;
                }
                const got = g.length === 1 ? (() => { const b = this._bytesFor(lines, g[0], PIDS[g[0]].bytes); return b ? { [g[0]]: b } : {}; })() : this._parseMulti(lines, g);
                if (g.length > 1 && !Object.keys(got).length && !/NO DATA/.test(joined)) {
                    this.log('warn', 'multi-PID answers do not parse here ("' + joined.slice(0, 60) + '"), asking one at a time');
                    this.multi = false;
                    break;
                }
                g.forEach((p) => { if (got[p]) this._store(p, got[p], now); else this.noData[p] = (this.noData[p] || 0) + 1; });
                if (Object.keys(got).length) errors = 0;
            }
            if (this.round % 20 === 0) {
                const v = await this.cmd('ATRV', 1000).catch(() => []);
                const volts = parseFloat(v[0]);
                if (isFinite(volts)) { this.info.volts = volts; this.values.volts = volts; this.stamps.volts = Date.now(); }
            }
            this.round++; n0++;
            if (Date.now() - t0 >= 2000) { this.roundHz = Math.round(n0 * 10000 / (Date.now() - t0)) / 10; t0 = Date.now(); n0 = 0; }
            this.emit('data', this.values);
        }
        return 'closed';
    }

    async _loop() {
        while (!this.stopped) {
            try {
                const dev = findDevice(this.cfg.OBD_DEVICE);
                if (!dev) { this._setState('searching', 'no adapter plugged in'); await sleep(3000); continue; }
                this._setState('connecting', dev);
                this.info = { device: dev };
                if (!await this._probe(dev)) {
                    this._setState('searching', 'no ELM327 answer on ' + dev + ' (wrong device or baud?)');
                    await sleep(5000); continue;
                }
                await this._init();
                while (this.port && !this.stopped) {
                    if (!await this._connectCar()) {
                        this._setState('waiting', 'adapter OK, car not answering: ignition off? ' + (this.info.lastError || ''));
                        const v = await this.cmd('ATRV', 1500).catch(() => []);
                        this.info.volts = parseFloat(v[0]) || this.info.volts;
                        this.values = this.info.volts ? { volts: this.info.volts } : {};
                        this.emit('data', this.values);
                        await sleep(4000); continue;
                    }
                    this._setState('live', this.info.protocol);
                    this.values = {}; this.stamps = {}; this.noData = {}; this.round = 0;
                    const why = await this._poll();
                    if (why === 'lost') this._setState('waiting', 'car stopped answering: ' + (this.info.lastError || ''));
                }
            } catch (e) {
                this.log('warn', e.message);
                this._closePort();
                await sleep(3000);
            }
        }
    }

    snapshot() {
        const now = Date.now();
        return {
            state: this.state, detail: this.detail, info: this.info, multi: this.multi, roundHz: this.roundHz,
            pids: Object.keys(PIDS).map(Number).filter((p) => this.supported.indexOf(p) >= 0).map((p) => {
                const d = PIDS[p];
                return { pid: hex2(p), name: d.name, label: d.label, unit: d.unit, value: this.values[d.name], age: this.stamps[d.name] ? now - this.stamps[d.name] : null, hz: this.rates[d.name] ? Math.round(this.rates[d.name] * 10) / 10 : null, dead: (this.noData[p] || 0) >= 3 };
            }),
            supported: this.supported.map(hex2),
        };
    }
}

module.exports = { Elm327, findDevice };
