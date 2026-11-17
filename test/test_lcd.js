'use strict';
/* node test/test_lcd.js: the LCD's detection (fake sysfs), touch matrix and calibration fit */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carhud-lcd-'));
const mk = (p, s) => { fs.mkdirSync(path.dirname(path.join(tmp, p)), { recursive: true }); fs.writeFileSync(path.join(tmp, p), s); };
mk('sys/class/graphics/fb0/name', 'vc4drmfb\n'); mk('sys/class/graphics/fb0/virtual_size', '1920,1080\n'); mk('sys/class/graphics/fb0/bits_per_pixel', '32\n');
mk('sys/class/graphics/fb1/name', 'fb_ili9486\n'); mk('sys/class/graphics/fb1/virtual_size', '480,320\n'); mk('sys/class/graphics/fb1/bits_per_pixel', '16\n');
mk('proc/bus/input/devices', 'I: Bus=0000 Vendor=0000 Product=1ea6\nN: Name="ADS7846 Touchscreen"\n');
process.env.CARHUD_SYS = path.join(tmp, 'sys'); process.env.CARHUD_PROC = path.join(tmp, 'proc');
const { Lcd, fitAffine } = require('../server/lcd');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('ok', n, m); };
const near = (a, b, m, eps) => ok(Math.abs(a - b) < (eps || 1e-3), m + ' (' + a.toFixed(4) + ' ≈ ' + b.toFixed(4) + ')');
const apply = (M, x, y) => [M[0] * x + M[1] * y + M[2], M[3] * x + M[4] * y + M[5]];

const lcd = new Lcd({ DATA_DIR: path.join(tmp, 'data'), LCD_MODEL: 'waveshare35a', LCD_ROTATE: '90' });
const fb = lcd.detect();
ok(fb && fb.dev === '/dev/fb1' && fb.width === 480 && fb.height === 320 && fb.bpp === 16, 'finds fb1 (fb_ili9486 480x320 16 bit), not the HDMI fb0');
ok(lcd.touchPresent(), 'finds the ADS7846 touch');
ok(lcd.matrix() === null, 'no matrix before carhud-screens places it');

// HDMI 1920x1080 at 0,0, LCD to its right: screen 2400x1080
const region = { x: 1920, y: 0, w: 480, h: 320, sw: 2400, sh: 1080 };
lcd.region = region;
let M = lcd.matrix();
ok(M.length === 9, 'a 3x3 matrix for xinput');
// waveshare35a at 90°: x raw 3932 → left edge, 300 → right; y raw 3801 → top, 294 → bottom (no swap)
let [x, y] = apply(M, 3932 / 4095, 3801 / 4095);
near(x * 2400, 1920, 'raw top-left lands on the LCD area\'s left edge'); near(y * 1080, 0, '... and top');
[x, y] = apply(M, 300 / 4095, 294 / 4095);
near(x * 2400, 2400, 'raw bottom-right lands on the right edge'); near(y * 1080, 320, '... and the LCD\'s bottom (320, not 1080)');

// a swapped model: waveshare35a at 0° swaps X and Y first
const lcd0 = new Lcd({ DATA_DIR: path.join(tmp, 'data0'), LCD_MODEL: 'waveshare35a', LCD_ROTATE: '0' });
lcd0.region = { x: 0, y: 0, w: 320, h: 480, sw: 320, sh: 480 };
M = lcd0.matrix();
// cal "3932 300 294 3801" applies to the swapped axes: raw y (now x) 3932 → left
[x, y] = apply(M, 294 / 4095, 3932 / 4095);
near(x, 0, 'swapped: raw y=3932 → left'); near(y, 0, 'swapped: raw x=294 → top');

// calibration: suppose taps land 4% right and 3% low, squeezed by 0.95, compared with the targets
const T = [[0.1, 0.12], [0.9, 0.12], [0.9, 0.88], [0.1, 0.88], [0.5, 0.5]];
const off = ([tx, ty]) => [tx * 0.95 + 0.04, ty * 0.97 + 0.03];
const A = fitAffine(T.map(off), T);
T.forEach((t) => { const o = off(t); near(A[0][0] * o[0] + A[0][1] * o[1] + A[0][2], t[0], 'fit maps observed x back'); });
lcd.region = region;
const before = lcd.matrix();
lcd.calibrate(T.map((t) => { const [ox, oy] = off(t); return { tx: t[0], ty: t[1], ox, oy }; }));
const after = lcd.matrix();
// a raw touch that used to land at off(t) on the LCD now lands at t
const toRaw = (M0, sx, sy) => {   // invert the old matrix (2x2 + offset) for a screen point
    const [a, b, c, d, e, f] = M0, det = a * e - b * d;
    return [(e * (sx - c) - b * (sy - f)) / det, (-d * (sx - c) + a * (sy - f)) / det];
};
T.forEach((t) => {
    const o = off(t);
    const raw = toRaw(before, (region.x + o[0] * region.w) / region.sw, (region.y + o[1] * region.h) / region.sh);
    const [sx, sy] = apply(after, raw[0], raw[1]);
    near((sx * region.sw - region.x) / region.w, t[0], 'after calibrating, the tap lands on target x');
    near((sy * region.sh - region.y) / region.h, t[1], 'after calibrating, the tap lands on target y');
});
ok(fs.existsSync(path.join(tmp, 'data', 'lcd-touch.json')), 'the correction is saved');
ok(new Lcd({ DATA_DIR: path.join(tmp, 'data'), LCD_MODEL: 'waveshare35a', LCD_ROTATE: '90' }).state().calibrated, '... and loaded again');
assert.throws(() => lcd.calibrate([{ tx: 0, ty: 0, ox: 0.5, oy: 0.5 }, { tx: 1, ty: 1, ox: 0.5, oy: 0.5 }, { tx: 0, ty: 1, ox: 0.5, oy: 0.5 }]), /close together/); ok(true, 'taps all in one spot are refused');
lcd.resetCalibration(); ok(!lcd.state().calibrated, 'reset');
const st = lcd.state();
ok(st.t === 'lcd' && st.models.waveshare35a && st.fb.dev === '/dev/fb1', 'state for the panels');
console.log('all ' + n + ' passed');
fs.rmSync(tmp, { recursive: true });
