'use strict';
/**
 * Turn-by-turn from a route and GPS fixes. The phone finds the route (it has the internet); the Pi
 * follows it: where you are along it, the next turn and how far, what's left, and whether you left it.
 *
 * Route format (what the phone app sends, built from an OSRM answer):
 *   { dest: {name, lat, lon}, coords: [[lon, lat], ...], distance: m, duration: s,
 *     steps: [{ type, modifier, name, distance, location: [lon, lat], text }] }
 */
const R = 6371000;
const rad = (d) => d * Math.PI / 180;

function haversine(a, b) {      // [lon, lat] points -> metres
    const dLat = rad(b[1] - a[1]), dLon = rad(b[0] - a[0]);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function bearing(a, b) {
    const y = Math.sin(rad(b[0] - a[0])) * Math.cos(rad(b[1]));
    const x = Math.cos(rad(a[1])) * Math.sin(rad(b[1])) - Math.sin(rad(a[1])) * Math.cos(rad(b[1])) * Math.cos(rad(b[0] - a[0]));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/** Closest point to p on segment a-b, in a local flat projection (fine over one segment). */
function project(p, a, b) {
    const k = Math.cos(rad(p[1]));
    const ax = a[0] * k, ay = a[1], bx = b[0] * k, by = b[1], px = p[0] * k, py = p[1];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    const q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    return { t, point: q, dist: haversine(p, q) };
}

/** Move `metres` along a polyline from its start: [lon, lat] and the heading there. */
function along(coords, cum, metres) {
    let i = 1;
    while (i < coords.length - 1 && cum[i] < metres) i++;
    const seg = cum[i] - cum[i - 1] || 1;
    const t = Math.max(0, Math.min(1, (metres - cum[i - 1]) / seg));
    return { point: [coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * t, coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * t], heading: bearing(coords[i - 1], coords[i]) };
}

class Nav {
    constructor() { this.clear(); }

    clear() {
        this.route = null; this.cum = null; this.stepAt = null;
        this.idx = 0; this.progress = null; this.offCount = 0;
    }

    set(route) {
        if (!route || !Array.isArray(route.coords) || route.coords.length < 2) throw new Error('route needs at least two points');
        this.clear();
        this.route = route;
        const c = route.coords;
        this.cum = [0];
        for (let i = 1; i < c.length; i++) this.cum.push(this.cum[i - 1] + haversine(c[i - 1], c[i]));
        // where along the line each step's manoeuvre is
        this.stepAt = (route.steps || []).map((s) => {
            if (!s.location) return null;
            let best = 0, bestD = Infinity;
            for (let i = 0; i < c.length; i++) { const d = haversine(c[i], s.location); if (d < bestD) { bestD = d; best = i; } }
            return this.cum[best];
        });
        this.total = this.cum[this.cum.length - 1];
    }

    /** A GPS fix {lat, lon, speed (km/h), accuracy (m)} -> progress */
    update(fix) {
        if (!this.route) return null;
        const p = [fix.lon, fix.lat], c = this.route.coords;
        // search near where we were last, then everywhere if that fails
        let best = null;
        const scan = (from, to) => {
            for (let i = Math.max(1, from); i < Math.min(c.length, to); i++) {
                const pr = project(p, c[i - 1], c[i]);
                if (!best || pr.dist < best.dist) best = { dist: pr.dist, i, at: this.cum[i - 1] + (this.cum[i] - this.cum[i - 1]) * pr.t };
            }
        };
        scan(this.idx - 5, this.idx + 60);
        if (!best || best.dist > 80) scan(1, c.length);
        this.idx = best.i;
        const done = best.at, left = Math.max(0, this.total - done);
        const off = best.dist > Math.max(45, (fix.accuracy || 0) * 1.5);
        this.offCount = off ? this.offCount + 1 : 0;
        // the next manoeuvre ahead of us (skip the "depart" one)
        const steps = this.route.steps || [];
        let next = null;
        for (let k = 0; k < steps.length; k++) {
            if (this.stepAt[k] === null || steps[k].type === 'depart') continue;
            if (this.stepAt[k] > done + 5) { next = k; break; }
        }
        const share = this.route.distance ? left / this.route.distance : 0;
        const speed = fix.speed > 5 ? fix.speed / 3.6 : null;
        const durLeft = this.route.duration ? this.route.duration * share : (speed ? left / speed : null);
        this.progress = {
            done: Math.round(done), left: Math.round(left), fromRoute: Math.round(best.dist),
            offRoute: this.offCount >= 3, arrived: left < 30,
            next: next === null ? null : Object.assign({}, steps[next], { index: next, distance: Math.round(this.stepAt[next] - done) }),
            after: next !== null && steps[next + 1] ? steps[next + 1] : null,
            secondsLeft: durLeft === null ? null : Math.round(durLeft),
            eta: durLeft === null ? null : Date.now() + durLeft * 1000,
        };
        return this.progress;
    }

    state() {
        if (!this.route) return null;
        return { dest: this.route.dest, distance: Math.round(this.total), duration: this.route.duration, coords: this.route.coords, steps: this.route.steps, progress: this.progress };
    }

    /** A pretend drive along the route, for testing at the desk: calls fix() every half second. */
    simulate(kmh, fix) {
        clearInterval(this.simTimer); this.simTimer = null;
        if (!kmh || !this.route) return false;
        let m = this.progress ? this.progress.done : 0;
        this.simTimer = setInterval(() => {
            m += kmh / 3.6 * 0.5;
            if (m >= this.total) { clearInterval(this.simTimer); this.simTimer = null; m = this.total; }
            const a = along(this.route.coords, this.cum, m);
            fix({ lat: a.point[1], lon: a.point[0], speed: this.simTimer ? kmh : 0, heading: a.heading, accuracy: 5, sim: true });
        }, 500);
        return true;
    }
    get simulating() { return !!this.simTimer; }
}

module.exports = { Nav, haversine, bearing };
