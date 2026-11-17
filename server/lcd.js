'use strict';
/**
 * The 3.5" SPI touch LCD on the Pi's header pins (ILI9486 + XPT2046/ADS7846: Waveshare 3.5" A/B/C,
 * MHS-3.5, the generic "3.5inch RPi Display"). It isn't an X output: the kernel's fbtft driver gives it a
 * framebuffer (/dev/fbN), so carhud-screens makes a virtual RandR monitor for it at the right of the real
 * displays, opens its window there, and copies that area to the LCD (ffmpeg). This module finds the LCD,
 * knows the models and works out the touch mapping.
 */
const fs = require('fs');
const path = require('path');

/* Touch calibration from the vendors' X config files, per model and rotation:
 * "minx maxx miny maxy" in raw 0..4095 touch units (a reversed pair means that axis runs backwards),
 * and whether X and Y are swapped first. */
const WS = { 0: ['3932 300 294 3801', 1], 90: ['3932 300 3801 294', 0], 180: ['300 3932 3801 294', 1], 270: ['300 3932 294 3801', 0] };
const WSC = { 0: ['3936 227 268 3880', 1], 90: ['3936 227 3880 268', 0], 180: ['227 3936 3880 268', 1], 270: ['227 3936 268 3880', 0] };
const GT = { 0: ['268 3880 227 3936', 0], 90: ['3936 227 268 3880', 1], 180: ['3880 268 3936 227', 0], 270: ['227 3936 3880 268', 1] };
const MODELS = {
    waveshare35a: { name: 'Waveshare 3.5" (A)', cal: WS },
    waveshare35b: { name: 'Waveshare 3.5" (B)', cal: WS },
    'waveshare35b-v2': { name: 'Waveshare 3.5" (B) rev 2', cal: WS },
    waveshare35c: { name: 'Waveshare 3.5" (C) high speed', cal: WSC },
    tft35a: { name: 'Generic 3.5" RPi Display (MPI3501, "LCD35-show", Kuman, Elegoo...)', cal: GT },
    mhs35: { name: 'MHS-3.5" (lcdwiki)', cal: GT },
};
const SYS = process.env.CARHUD_SYS || '/sys', PROC = process.env.CARHUD_PROC || '/proc';   // tests point these at fakes
const FB_NAMES = /ili9486|ili9488|ili9341|st7796|hx8357|fb_|fbtft/i;

class Lcd {
    constructor(cfg) {
        this.cfg = cfg;
        this.file = path.join(cfg.DATA_DIR, 'lcd-touch.json');
        try { this.saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { this.saved = {}; }
        this.region = this.saved.region || null;   // kept, so a server restart doesn't forget where the LCD is
    }

    /** the LCD's framebuffer, if the driver is loaded: {dev, name, width, height, bpp} */
    detect() {
        let list = [];
        try { list = fs.readdirSync(path.join(SYS, 'class/graphics')).filter((f) => /^fb\d+$/.test(f)); } catch (e) { return null; }
        for (const fb of list.sort()) {
            const rd = (f) => { try { return fs.readFileSync(path.join(SYS, 'class/graphics', fb, f), 'utf8').trim(); } catch (e) { return ''; } };
            const name = rd('name');
            if (!FB_NAMES.test(name) || /vc4|drmfb/i.test(name)) continue;
            const [w, h] = rd('virtual_size').split(',').map(Number);
            return { dev: '/dev/' + fb, name, width: w || 480, height: h || 320, bpp: Number(rd('bits_per_pixel')) || 16 };
        }
        return null;
    }

    touchPresent() {
        try { return /ADS7846|XPT2046/i.test(fs.readFileSync(path.join(PROC, 'bus/input/devices'), 'utf8')); } catch (e) { return false; }
    }

    model() { return this.cfg.LCD_MODEL || ''; }
    rotate() { const r = Number(this.cfg.LCD_ROTATE); return [0, 90, 180, 270].includes(r) ? r : 90; }

    /** the vendor calibration (or LCD_TOUCH_CAL / LCD_TOUCH_SWAP from the settings) */
    calibration() {
        const m = MODELS[this.model()] || MODELS.tft35a;
        const [cal, swap] = m.cal[this.rotate()];
        const c = (this.cfg.LCD_TOUCH_CAL || cal).trim().split(/\s+/).map(Number);
        const s = this.cfg.LCD_TOUCH_SWAP === '' || this.cfg.LCD_TOUCH_SWAP === undefined ? swap : Number(this.cfg.LCD_TOUCH_SWAP);
        return { cal: c.length === 4 && c.every(isFinite) ? c : cal.split(' ').map(Number), swap: !!s };
    }

    /** libinput's Coordinate Transformation Matrix for the touch layer: raw touch -> the LCD's area of the X screen */
    matrix(region) {
        const r = region || this.region;
        if (!r) return null;
        const { cal: [a, b, c, d], swap } = this.calibration();
        const S = swap ? [[0, 1, 0], [1, 0, 0], [0, 0, 1]] : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
        const K = [[4095 / (b - a), 0, -a / (b - a)], [0, 4095 / (d - c), -c / (d - c)], [0, 0, 1]];
        const C = this.saved.correction || [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
        const R = [[r.w / r.sw, 0, r.x / r.sw], [0, r.h / r.sh, r.y / r.sh], [0, 0, 1]];
        const M = mul(R, mul(C, mul(K, S)));
        return M.flat().map((v) => Math.round(v * 1e6) / 1e6);
    }

    /** taps on targets: [{tx, ty, ox, oy}] (target and where it landed, 0..1 across the LCD) -> new correction */
    calibrate(points) {
        if (!Array.isArray(points) || points.length < 3) throw new Error('need at least 3 taps');
        const A = fitAffine(points.map((p) => [p.ox, p.oy]), points.map((p) => [p.tx, p.ty]));
        const C = this.saved.correction || [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
        this.saved.correction = mul(A, C);
        this._save();
        return this.saved.correction;
    }
    setRegion(r) { this.region = r; this.saved.region = r; this._save(); }
    resetCalibration() { delete this.saved.correction; this._save(); }
    _save() { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.saved, null, 1)); }

    state() {
        const fb = this.detect();
        return { t: 'lcd', model: this.model(), modelName: (MODELS[this.model()] || {}).name || '', rotate: this.rotate(), fb, touch: this.touchPresent(),
            region: this.region, calibrated: !!this.saved.correction, models: Object.fromEntries(Object.entries(MODELS).map(([k, v]) => [k, v.name])) };
    }
}

function mul(A, B) { return A.map((row, i) => B[0].map((_, j) => row.reduce((s, v, k) => s + v * B[k][j], 0))); }

/** least-squares affine map from src points to dst points (3x3 matrix) */
function fitAffine(src, dst) {
    // solve for [a b c] in x' = a x + b y + c, and [d e f] for y', via normal equations
    const solve = (vals) => {
        let n = src.length, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sv = 0, sxv = 0, syv = 0;
        src.forEach(([x, y], i) => { const v = vals[i]; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sv += v; sxv += x * v; syv += y * v; });
        const m = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]], r = [sxv, syv, sv];
        return gauss(m, r);
    };
    const [a, b, c] = solve(dst.map((p) => p[0])), [d, e, f] = solve(dst.map((p) => p[1]));
    return [[a, b, c], [d, e, f], [0, 0, 1]];
}
function gauss(m, r) {
    const n = 3, A = m.map((row, i) => row.concat([r[i]]));
    for (let i = 0; i < n; i++) {
        let p = i; for (let k = i + 1; k < n; k++) if (Math.abs(A[k][i]) > Math.abs(A[p][i])) p = k;
        [A[i], A[p]] = [A[p], A[i]];
        if (Math.abs(A[i][i]) < 1e-12) throw new Error('the taps were too close together');
        for (let k = 0; k < n; k++) if (k !== i) { const f = A[k][i] / A[i][i]; for (let j = i; j <= n; j++) A[k][j] -= f * A[i][j]; }
    }
    return A.map((row, i) => row[n] / A[i][i]);
}

module.exports = { Lcd, MODELS, fitAffine };
