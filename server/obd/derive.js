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
const DEFAULT_RATIOS = [117, 69, 47, 36, 29, 24];     // a generic 6-speed: set yours with `carhud gears`

class Derive {
    constructor(cfg) {
        const list = String(cfg.OBD_GEAR_RATIOS || '').split(/[,\s]+/).map(Number).filter((n) => n > 0);
        this.ratios = list.length ? list : DEFAULT_RATIOS;
        this.ratiosConfigured = list.length > 0;
        this.stoich = Number(cfg.OBD_FUEL_AFR) || 14.7;
        this.gear = 0; this.cand = 0; this.candSince = 0; this.stillSince = 0;
        this.lastSpeed = null; this.lastSpeedAt = 0; this.gLong = 0;
        this.ratio = null;
    }

    _gear(rpm, speed, now) {
        if (!(rpm > 400)) { this.gear = 0; return 0; }                     // engine off
        if (!(speed >= 3)) {
            if (!this.stillSince) this.stillSince = now;
            if (now - this.stillSince > 2000) this.gear = 0;                 // standing: the parked screens
            this.ratio = null;
            return this.gear;
        }
        this.stillSince = 0;
        const r = rpm / speed;
        this.ratio = Math.round(r * 10) / 10;
        let best = 0, bestErr = 0.12;
        this.ratios.forEach((g, i) => { const err = Math.abs(r - g) / g; if (err < bestErr) { bestErr = err; best = i + 1; } });
        if (!best) return this.gear;                                         // clutch in / shifting: keep the last gear
        if (best !== this.cand) { this.cand = best; this.candSince = now; }
        if (best !== this.gear && now - this.candSince >= 250) this.gear = best;
        if (!this.gear) this.gear = best;
        return this.gear;
    }

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
        if (num(v.pedal)) out.pedal = v.pedal; else if (num(v.throttle)) out.pedal = v.throttle;
        if (num(v.fuelRail)) out.fuel = v.fuelRail;
        const lambda = num(v.lambda) ? v.lambda : v.lambda34;
        if (num(lambda) && lambda > 0.5 && lambda < 1.99) out.afr = Math.round(lambda * this.stoich * 10) / 10;
        if (num(v.fuelRate)) out.burn = v.fuelRate;
        else if (num(v.maf)) out.burn = Math.round(v.maf * 3600 / ((out.afr || this.stoich) * 745) * 10) / 10;
        return out;
    }
}

module.exports = { Derive, DEFAULT_RATIOS };
