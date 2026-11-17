'use strict';
/**
 * Screens: which picture goes on which display.
 *
 * Every connected output (HDMI-1, DSI-1, ...) shows /display?output=NAME, a page that holds whatever is
 * assigned to that output and swaps it the moment the assignment changes. Choosing "desktop" closes the
 * page so the plain Openbox desktop shows; "off" turns the output off. Those two, and rotation, need
 * carhud-screens to redo the layout; everything else switches inside the page with no restart.
 *
 * Assignments are kept in ~/.carhud/screens.json per output name.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');

const TYPES = {
    hud: 'HUD',
    desk: 'Desk (home screen)',
    console: 'Console (control panel)',
    debug: 'Debug console (small screens)',
    terminal: 'Terminal (command line)',
    gauges: 'Gauges',
    navigate: 'Navigation',
    phone: 'Phone & music',
    blank: 'Black (screen on, nothing shown)',
    url: 'A web address',
    desktop: 'Desktop (no CarHUD window)',
    off: 'Off',
};
const ROTATIONS = ['normal', 'left', 'right', 'inverted'];

const LCD = 'LCD';    // the SPI touch screen on the header pins: not an X output, see lcd.js

class Screens extends EventEmitter {
    constructor(cfg, lcd) {
        super();
        this.cfg = cfg;
        this.lcd = lcd || null;
        this.file = path.join(cfg.DATA_DIR, 'screens.json');
        this.outputs = [];          // [{name, connected, width, height, x, y, primary}]
        this.xOk = false;
        this.saved = {};
        try { this.saved = JSON.parse(fs.readFileSync(this.file, 'utf8')).outputs || {}; } catch (e) { /* first run */ }
        this.refresh();
        setInterval(() => this.refresh(), 15000);
    }

    env() { return Object.assign({}, process.env, { DISPLAY: process.env.DISPLAY || ':0', XAUTHORITY: process.env.XAUTHORITY || path.join(os.homedir(), '.Xauthority') }); }

    /** ask X which outputs are connected */
    refresh(cb) {
        execFile('xrandr', ['--query'], { env: this.env(), timeout: 4000 }, (err, out) => {
            const before = JSON.stringify(this.outputs.map((o) => [o.name, o.connected, o.width, o.height]));
            if (err) { this.xOk = false; this.outputs = []; }
            else {
                this.xOk = true;
                this.outputs = String(out).split('\n').map((l) => {
                    const m = /^(\S+) (connected|disconnected)( primary)?(?: (\d+)x(\d+)\+(\d+)\+(\d+))?/.exec(l);
                    return m && { name: m[1], connected: m[2] === 'connected', primary: !!m[3], width: m[4] ? Number(m[4]) : null, height: m[5] ? Number(m[5]) : null, x: m[6] ? Number(m[6]) : null, y: m[7] ? Number(m[7]) : null };
                }).filter(Boolean).filter((o) => o.connected);
            }
            const fb = this.lcd && this.lcd.detect();
            if (fb) {
                const r = this.lcd.region;
                this.outputs.push({ name: LCD, connected: true, primary: false, virtual: true, fb: fb.dev, width: fb.width, height: fb.height, x: r ? r.x : null, y: r ? r.y : null });
            }
            if (JSON.stringify(this.outputs.map((o) => [o.name, o.connected, o.width, o.height])) !== before) this.emit('change');
            if (cb) cb();
        });
    }

    /** the old settings (v2.2 and before) decide the first layout: HUD on HDMI, desk on the other */
    defaults(name, index, names) {
        const c = this.cfg;
        if (name === LCD) return { screen: 'debug', mirror: false, flip: false, bmw: false, rotate: 'normal', url: '' };
        names = names.filter((n) => n !== LCD);
        const hudOut = c.HUD_OUTPUT && c.HUD_OUTPUT !== 'auto' ? c.HUD_OUTPUT : (names.find((n) => /^HDMI/.test(n)) || names[0]);
        const deskOut = c.DESK_OUTPUT && c.DESK_OUTPUT !== 'auto' ? c.DESK_OUTPUT : (names.find((n) => /^DSI/.test(n) && n !== hudOut) || names.find((n) => n !== hudOut));
        const screen = name === hudOut ? 'hud' : name === deskOut ? 'desk' : 'console';
        return { screen, mirror: c.HUD_MIRROR === '1', flip: c.HUD_FLIP === '1', bmw: c.HUD_BMW_ZONE === '1', rotate: 'normal', url: '' };
    }

    /** what each output shows: saved choices for the outputs we know, defaults for new ones */
    assignments() {
        const names = this.outputs.map((o) => o.name);
        const all = {};
        Object.keys(this.saved).forEach((n) => { all[n] = Object.assign({}, this.defaults(n, 0, names), this.saved[n]); });
        names.forEach((n, i) => { if (!all[n]) all[n] = this.defaults(n, i, names); });
        return all;
    }

    state() {
        return { t: 'screens', x: this.xOk, outputs: this.outputs, assignments: this.assignments(), types: TYPES, rotations: ROTATIONS };
    }

    /** change one output's assignment. Returns what has to happen: 'page' (the page swaps), 'window' or 'layout'. */
    set(output, changes) {
        if (!output) throw new Error('which output?');
        const cur = this.assignments()[output] || this.defaults(output, 0, this.outputs.map((o) => o.name));
        const next = Object.assign({}, cur);
        if (changes.screen !== undefined) { if (!TYPES[changes.screen]) throw new Error('unknown screen ' + changes.screen); next.screen = changes.screen; }
        ['mirror', 'flip', 'bmw'].forEach((k) => { if (changes[k] !== undefined) next[k] = !!changes[k]; });
        if (changes.rotate !== undefined && output === LCD && changes.rotate !== 'normal') throw new Error('the LCD is turned when it is set up: carhud lcd setup MODEL 0|90|180|270');
        if (changes.rotate !== undefined) { if (!ROTATIONS.includes(changes.rotate)) throw new Error('rotate: ' + ROTATIONS.join(', ')); next.rotate = changes.rotate; }
        if (changes.url !== undefined) next.url = String(changes.url);
        if (next.screen === 'url' && !/^(https?:|\/)/.test(next.url)) throw new Error('give a web address (http://...)');
        this.saved[output] = next;
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify({ outputs: this.saved }, null, 1));
        // "off", rotation and the LCD's own changes move other things around; a terminal or no window means a new window
        const off = (a) => a.screen === 'off', win = (a) => (a.screen === 'desktop' ? 'none' : a.screen === 'terminal' ? 'term' : 'page');
        let needs = 'page';
        if (off(cur) !== off(next) || cur.rotate !== next.rotate) needs = output === LCD ? 'window' : 'layout';
        else if (win(cur) !== win(next)) needs = 'window';
        this.emit('change');
        return needs;
    }

    /** for carhud-screens: one line per connected output, "NAME SCREEN ROTATE", in layout order;
     *  the LCD last, as "LCD SCREEN normal WxH /dev/fbN BPP" */
    layoutText() {
        const a = this.assignments();
        return this.outputs.map((o) => o.name + ' ' + a[o.name].screen + ' ' + (a[o.name].rotate || 'normal') +
            (o.virtual ? ' ' + o.width + 'x' + o.height + ' ' + o.fb + ' ' + ((this.lcd.detect() || {}).bpp || 16) : '')).join('\n') + '\n';
    }
}

module.exports = { Screens, TYPES, LCD };
