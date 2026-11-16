'use strict';
/**
 * Runs the EVA HUD app: builds it with its kit (kit/tools/build.py) when its sources changed, then runs
 * the built app in the project's stubbed head unit (bench/run-app.js), pointed at our renderer socket.
 *
 * Events: 'log' (level, text), 'values' (what the app sees), 'settings', 'status', 'state' ('building'|'running'|'stopped')
 */
const fs = require('fs');
const path = require('path');
const { fork, execFile } = require('child_process');
const { EventEmitter } = require('events');

const APP_ID = 'eva_hud';

function newestMtime(dir) {
    let t = 0;
    const walk = (d) => {
        let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
        ents.forEach((e) => {
            if (e.name[0] === '.' || e.name === '__pycache__') return;
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else { try { t = Math.max(t, fs.statSync(p).mtimeMs); } catch (x) { /* gone */ } }
        });
    };
    walk(dir);
    return t;
}

class Eva extends EventEmitter {
    constructor({ evaDir, dataDir, sockPath, watch }) {
        super();
        this.dir = evaDir;
        this.dataDir = dataDir;
        this.sockPath = sockPath;
        this.stage = path.join(evaDir, 'dist', APP_ID);
        this.child = null;
        this.state = 'stopped';
        this.signals = { t: 'signals', mode: 'demo', values: {} };
        this.drive = null;
        this.settings = null;
        this.status = '';
        this.values = {};
        this.valuesMode = 'demo';
        this._stopping = false;
        if (watch) this._watch();
    }

    _set(state) { this.state = state; this.emit('state', state); }
    log(level, text) { this.emit('log', level, text); }

    _sources() { return ['apps/' + APP_ID, 'shared', 'kit', 'bench/run-app.js'].map((p) => path.join(this.dir, p)); }

    _needsBuild() {
        const marker = path.join(this.stage, '.carhud-built');
        let built = 0; try { built = fs.statSync(marker).mtimeMs; } catch (e) { return true; }
        return this._sources().some((p) => {
            try { return fs.statSync(p).isDirectory() ? newestMtime(p) > built : fs.statSync(p).mtimeMs > built; } catch (e) { return false; }
        });
    }

    _build(force) {
        return new Promise((resolve) => {
            if (!force && !this._needsBuild()) { this.log('info', 'HUD app is up to date, no build needed'); return resolve(true); }
            this._set('building');
            const sdk = path.join(this.dir, 'oap-sdk');
            if (!fs.existsSync(path.join(sdk, 'index.js'))) {
                fs.mkdirSync(sdk, { recursive: true });
                fs.writeFileSync(path.join(sdk, 'index.js'), "'use strict';\n// stand-in for BMW's oap-sdk so kit/tools/build.py runs off the car\nthrow new Error('stub oap-sdk');\n");
                fs.writeFileSync(path.join(sdk, 'package.json'), JSON.stringify({ name: 'oap-sdk', version: '0.0.0-stub', main: 'index.js' }) + '\n');
            }
            const t0 = Date.now();
            this.log('info', 'building the HUD app...');
            execFile('python3', [path.join(this.dir, 'kit', 'tools', 'build.py'), APP_ID], { cwd: this.dir, maxBuffer: 4e6 }, (err, out, errOut) => {
                if (err) { this.log('error', 'build failed: ' + String(errOut || err.message).trim()); return resolve(false); }
                try { fs.writeFileSync(path.join(this.stage, '.carhud-built'), new Date().toISOString() + '\n'); } catch (e) { /* stage missing */ }
                this.log('info', 'build done in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
                resolve(true);
            });
        });
    }

    async start(forceBuild) {
        if (this.child) return;
        if (!fs.existsSync(path.join(this.dir, 'apps', APP_ID, 'app.json'))) {
            this.log('error', 'the HUD project is not at ' + this.dir + ' (EVA_DIR)');
            return this._set('stopped');
        }
        fs.mkdirSync(this.dataDir, { recursive: true });
        if (!await this._build(forceBuild)) return this._set('stopped');
        const env = Object.assign({}, process.env, { HUD_CLUSTER_SOCKET: this.sockPath });
        const c = fork(path.join(this.dir, 'bench', 'run-app.js'), [this.stage, this.dataDir], { cwd: this.dataDir, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env });
        this.child = c;
        const pipe = (stream, level) => {
            let rest = '';
            stream.on('data', (d) => {
                const lines = (rest + d).split('\n'); rest = lines.pop();
                lines.forEach((ln) => ln && this.log(/WARN|ERROR|Error/.test(ln) ? 'warn' : level, 'app: ' + ln.replace(/^\[eva_hud\] /, '')));
            });
        };
        pipe(c.stdout, 'info'); pipe(c.stderr, 'warn');
        c.on('message', (m) => {
            if (!m) return;
            if (m.t === 'values') { this.values = m.values; this.valuesMode = m.mode; this.emit('values', m.values); }
            else if (m.t === 'settings') { this.settings = { schema: m.schema, values: m.values }; this.emit('settings', this.settings); }
            else if (m.t === 'status') { this.status = m.s; this.emit('status', m.s); }
        });
        c.on('exit', (code, sig) => {
            if (c !== this.child) return;
            this.child = null;
            this._set('stopped');
            if (!this._stopping) {
                this.log('error', 'HUD app exited (code ' + code + (sig ? ', ' + sig : '') + '), restarting in 3 s');
                setTimeout(() => this.start(), 3000);
            }
        });
        c.send(this.signals);
        if (this.drive !== null) c.send({ t: 'drive', value: this.drive });
        this._set('running');
        this.log('info', 'HUD app started (node ' + process.version + ')');
    }

    stop() {
        return new Promise((resolve) => {
            const c = this.child;
            if (!c) return resolve();
            this._stopping = true;
            this.child = null;
            c.once('exit', () => { this._stopping = false; this._set('stopped'); resolve(); });
            c.kill('SIGTERM');
            setTimeout(() => { try { c.kill('SIGKILL'); } catch (e) { /* gone */ } }, 1500);
        });
    }

    async restart(why, rebuild) { this.log('info', 'restarting HUD app: ' + why); await this.stop(); await this.start(rebuild); }

    _send(m) { if (this.child && this.child.connected) this.child.send(m); }

    /** mode 'demo' = the app's own demo loop; 'manual' = exactly these values, held */
    setSignals(mode, values) { this.signals = { t: 'signals', mode, values: values || {} }; this._send(this.signals); }
    setDrive(value) { this.drive = value; this._send({ t: 'drive', value }); }
    setSetting(key, value) { this._send({ t: 'set', key, value }); }

    _watch() {
        let timer = null;
        ['apps/' + APP_ID, 'shared', 'kit'].forEach((p) => {
            try {
                fs.watch(path.join(this.dir, p), { recursive: true }, (ev, file) => {
                    if (!file || /(^|\/)\./.test(file) || /__pycache__/.test(file)) return;
                    clearTimeout(timer);
                    timer = setTimeout(() => this.restart(p + '/' + file + ' changed', true), 400);
                });
            } catch (e) { this.log('warn', 'cannot watch ' + p + ': ' + e.message); }
        });
        this.log('info', 'EVA_WATCH on: editing the HUD project rebuilds it');
    }
}

module.exports = { Eva };
