'use strict';
/**
 * OBD readings -> the values the HUD takes (rpm, speed, gear, boost, ...).
 * Things OBD-II does not report directly are worked out:
 *   gear   from engine rpm per km/h, matched against OBD_GEAR_RATIOS
 *   boost  manifold pressure minus barometric pressure, in bar
 *   gLong  from the change in speed
 *   afr    lambda x stoichiometric AFR
 *   burn   fuel rate in L/h (PID 5E, or estimated from mass air flow)
 */
const fs = require('fs');
const path = require('path');
const DEFAULT_RATIOS = [117, 69, 47, 36, 29, 24];     // a generic 6-speed: set yours with `carhud gears learn`

class Derive {
    constructor(cfg) {
        this.cfg = cfg;
        this.gearFile = path.join(cfg.DATA_DIR || '.', 'gears.json');
        this.learnState = null;       // while learning: { since, samples: [ratio...] }
        this.recent = [];             // the last few rpm/km/h readings, to smooth and to tell steady driving
        this.loadRatios();
        this.stoich = Number(cfg.OBD_FUEL_AFR) || 14.7;
        this.gear = 0; this.cand = 0; this.candSince = 0; this.stillSince = 0;
        this.lastSpeed = null; this.lastSpeedAt = 0; this.gLong = 0;
        this.ratio = null;
        // the pedal/throttle sensors never read 0 at rest (often ~15%) nor 100 flat out: learn both ends
        this.pedalFile = path.join(cfg.DATA_DIR || '.', 'pedal.json');
        try { this.pedalCal = JSON.parse(fs.readFileSync(this.pedalFile, 'utf8')); } catch (e) { this.pedalCal = {}; }
        this.pedalSavedAt = 0;
    }

    /** raw sensor % -> 0 at rest .. 100 flat out (rest = the lowest it reads, full = the highest seen) */
    _pedal(raw, src, now) {
        const c = this.pedalCal[src] || (this.pedalCal[src] = { rest: raw, full: null });
        let changed = false;
        // a new, lower rest position only after 3 readings in a row (one glitchy 0 must not stick)
        if (raw < c.rest - 0.2) { this.lowCount = (this.lowCount || 0) + 1; if (this.lowCount >= 3) { c.rest = raw; changed = true; } } else this.lowCount = 0;
        if (c.full === null || raw > c.full) { c.full = raw; changed = true; }
        if (changed && now - this.pedalSavedAt > 10000) {
            this.pedalSavedAt = now;
            try { fs.mkdirSync(path.dirname(this.pedalFile), { recursive: true }); fs.writeFileSync(this.pedalFile, JSON.stringify(this.pedalCal)); } catch (e) { /* not saved */ }
        }
        // flat out is the highest it has read, but at least 65% of the way above rest (sensors top out ~75-90%),
        // so until the first time flat out, part throttle reads a little high
        const full = Math.max(c.full, c.rest + (100 - c.rest) * 0.65);
        const v = (raw - c.rest) / (full - c.rest) * 100;
        return Math.round(Math.min(100, Math.max(0, v < 1.5 ? 0 : v)));
    }
    resetPedal() { this.pedalCal = {}; try { fs.unlinkSync(this.pedalFile); } catch (e) { /* none */ } }

    /** the ratios: learned by driving (~/.carhud/gears.json) first, then OBD_GEAR_RATIOS, then a generic 6-speed */
    loadRatios() {
        let learned = null;
        try { learned = JSON.parse(fs.readFileSync(this.gearFile, 'utf8')).ratios; } catch (e) { /* none yet */ }
        const list = String(this.cfg.OBD_GEAR_RATIOS || '').split(/[,\s]+/).map(Number).filter((n) => n > 0);
        if (Array.isArray(learned) && learned.length) { this.ratios = learned; this.ratiosFrom = 'learned'; }
        else if (list.length) { this.ratios = list; this.ratiosFrom = 'settings'; }
        else { this.ratios = DEFAULT_RATIOS; this.ratiosFrom = 'generic'; }
        this.ratiosConfigured = this.ratiosFrom !== 'generic';
    }

    _gear(rpm, speed, now) {
        if (!(rpm > 400)) { this.gear = 0; this.recent = []; return 0; }    // engine off
        if (!(speed >= 3)) {
            if (!this.stillSince) this.stillSince = now;
            if (now - this.stillSince > 2000) this.gear = 0;                 // standing: the parked screens
            this.ratio = null; this.recent = [];
            return this.gear;
        }
        this.stillSince = 0;
        const raw = rpm / speed;
        this.recent.push({ r: raw, t: now, speed });
        while (this.recent.length && now - this.recent[0].t > 700) this.recent.shift();
        // median of the last ~0.7 s: one reading of rpm and speed taken a moment apart can't flip the gear
        const sorted = this.recent.map((x) => x.r).sort((a, b) => a - b);
        const r = sorted[Math.floor(sorted.length / 2)];
        this.ratio = Math.round(r * 10) / 10;
        // steady: the readings agree within 3% (clutch engaged, not mid-shift)
        const steady = this.recent.length >= 3 && sorted[sorted.length - 1] / sorted[0] < 1.03;
        if (this.learnState && steady && speed >= 12 && rpm >= 900) this.learnState.samples.push(r);
        // speed comes in whole km/h, so below ~10 km/h a reading is off by up to 10%: allow for that
        const slack = 1 / speed;
        let best = 0, bestErr = Infinity;
        this.ratios.forEach((g, i) => { const err = Math.abs(Math.log(r / g)); if (err < bestErr) { bestErr = err; best = i + 1; } });
        // nearer than halfway (in ratio terms) to the next gear, and within 12% (+ the rounding slack)
        const g = this.ratios[best - 1], neighbour = Math.min(...this.ratios.filter((x) => x !== g).map((x) => Math.abs(Math.log(x / g))), Infinity);
        if (!best || bestErr > Math.min(0.12 + slack, neighbour * 0.5 + slack)) return this.gear;   // clutch in / coasting / shifting: keep the last gear
        if (best !== this.cand) { this.cand = best; this.candSince = now; }
        if (best !== this.gear && now - this.candSince >= (steady ? 250 : 600)) this.gear = best;
        if (!this.gear) this.gear = best;
        return this.gear;
    }

    /* ---- learning the ratios by driving: each gear held steady for a few seconds ---- */
    learn(on) {
        if (on) this.learnState = { since: Date.now(), samples: [] };
        else this.learnState = null;
        return this.learning();
    }
    /** what has been learned so far: groups of steady rpm/km/h readings, one per gear driven */
    learning() {
        const L = this.learnState;
        if (!L) return { learning: false, ratios: this.ratios, from: this.ratiosFrom };
        const xs = L.samples.slice().sort((a, b) => b - a), groups = [];
        let cur = [];
        for (const x of xs) {
            if (cur.length && cur[cur.length - 1] / x > 1.06) { groups.push(cur); cur = []; }   // a gap of 6%+ starts the next gear
            cur.push(x);
        }
        if (cur.length) groups.push(cur);
        const found = groups.filter((g) => g.length >= 15)       // a few seconds of steady driving in that gear
            .map((g) => ({ ratio: Math.round(g[Math.floor(g.length / 2)] * 10) / 10, samples: g.length, spread: Math.round((g[0] / g[g.length - 1] - 1) * 1000) / 10 }));
        return { learning: true, seconds: Math.round((Date.now() - L.since) / 1000), samples: L.samples.length, gears: found, ratios: this.ratios, from: this.ratiosFrom };
    }
    /** keep what was learned: the groups, highest ratio (1st gear) first */
    saveLearned() {
        const l = this.learning();
        if (!l.learning) throw new Error('not learning: start with carhud gears learn');
        if (l.gears.length < 2) throw new Error('only ' + l.gears.length + ' gear(s) found so far: hold each gear steady for 5+ seconds above 15 km/h');
        const ratios = l.gears.map((g) => g.ratio);
        fs.mkdirSync(path.dirname(this.gearFile), { recursive: true });
        fs.writeFileSync(this.gearFile, JSON.stringify({ ratios, learned: new Date().toISOString(), samples: l.samples }, null, 1));
        this.learnState = null;
        this.loadRatios();
        return ratios;
    }
    forgetLearned() { try { fs.unlinkSync(this.gearFile); } catch (e) { /* none */ } this.loadRatios(); }

    hud(v, now) {
        const num = (x) => typeof x === 'number' && isFinite(x);
        const out = {};
        if (num(v.rpm)) out.rpm = v.rpm;
        if (num(v.speed)) {
            out.speed = v.speed;
            if (this.lastSpeed !== null && now - this.lastSpeedAt >= 150) {
                const a = ((v.speed - this.lastSpeed) / 3.6) / ((now - this.lastSpeedAt) / 1000) / 9.80665;
                if (Math.abs(a) < 2) this.gLong = 0.7 * this.gLong + 0.3 * a;
                this.lastSpeed = v.speed; this.lastSpeedAt = now;
            } else if (this.lastSpeed === null) { this.lastSpeed = v.speed; this.lastSpeedAt = now; }
            out.gLong = Math.round(this.gLong * 100) / 100;
            out.gLat = 0;
        }
        if (num(v.rpm) && num(v.speed)) out.gear = this._gear(v.rpm, v.speed, now);
        if (num(v.coolant)) out.coolant = v.coolant;
        if (num(v.oil)) out.oil = v.oil;
        const map = num(v.map2) ? v.map2 : v.map;
        if (num(map)) out.boost = Math.max(0, Math.round((map - (num(v.baro) ? v.baro : 101.3)) / 100 * 100) / 100);
        if (num(v.torquePct) && num(v.torqueRef)) out.torque = Math.round(v.torquePct / 100 * v.torqueRef);
        if (num(v.pedal)) out.pedal = this._pedal(v.pedal, 'pedal', now); else if (num(v.throttle)) out.pedal = this._pedal(v.throttle, 'throttle', now);
        if (num(v.fuelRail)) out.fuel = v.fuelRail;
        const lambda = num(v.lambda) ? v.lambda : v.lambda34;
        if (num(lambda) && lambda > 0.5 && lambda < 1.99) out.afr = Math.round(lambda * this.stoich * 10) / 10;
        if (num(v.fuelRate)) out.burn = v.fuelRate;
        else if (num(v.maf)) out.burn = Math.round(v.maf * 3600 / ((out.afr || this.stoich) * 745) * 10) / 10;
        return out;
    }
}

module.exports = { Derive, DEFAULT_RATIOS };
