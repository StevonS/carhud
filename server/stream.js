'use strict';
/**
 * Sends the HUD to every display that watches it, without falling behind.
 *
 * Each client keeps, per layer, the box of pixels that changed since it was last sent ("dirty").
 * A flush sends just those boxes, cut from the layer's current image. A client whose socket is still
 * full (a slow Wi-Fi laptop) is skipped until it drains, so its changes pile up into one box and it
 * always gets the newest picture instead of a queue of old frames. That is what keeps latency flat.
 * Displays acknowledge each message, and no more than MAX_IN_FLIGHT go unacknowledged, so the
 * network's own buffers can't hold a backlog either.
 *
 * Binary pixel message (little endian):
 *   u8 type=1, u8 keyLen, key (ascii), f64 server time ms, u16 iw, u16 ih, u16 x, u16 y, u16 w, u16 h, RGBA rows
 */
const HIGH_WATER = 192 * 1024;
const MAX_IN_FLIGHT = 4;      // messages sent but not yet acknowledged by the display (it acks each one)

function union(a, b) {
    if (!a) return Object.assign({}, b);
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

function crop(l, b) {
    const key = Buffer.from(l.key, 'ascii');
    const head = Buffer.alloc(2 + key.length + 8 + 12);
    let o = 0;
    head[o++] = 1; head[o++] = key.length; key.copy(head, o); o += key.length;
    head.writeDoubleLE(Date.now(), o); o += 8;
    [l.iw, l.ih, b.x, b.y, b.w, b.h].forEach((v) => { head.writeUInt16LE(v, o); o += 2; });
    if (b.x === 0 && b.w === l.iw) {
        return Buffer.concat([head, l.image.slice(b.y * l.iw * 4, (b.y + b.h) * l.iw * 4)]);
    }
    const px = Buffer.alloc(b.w * b.h * 4);
    for (let r = 0; r < b.h; r++) l.image.copy(px, r * b.w * 4, ((b.y + r) * l.iw + b.x) * 4, ((b.y + r) * l.iw + b.x + b.w) * 4);
    return Buffer.concat([head, px]);
}

class Streamer {
    constructor(renderer) {
        this.r = renderer;
        this.clients = new Set();
        renderer.on('pixels', (l, box) => this.clients.forEach((c) => {
            if (!this._wants(c, l)) return;
            c.dirty.set(l.key, union(c.dirty.get(l.key), box));
            this._schedule(c);
        }));
        renderer.on('scene', () => this.clients.forEach((c) => { c.sceneDirty = true; this._schedule(c); }));
    }

    _wants(c, l) { return c.target === 'all' || l.target === c.target; }

    /** A display joins: it gets the scene and every image once, then only changes. */
    add(ws, target, maxFps) {
        const c = { ws, target, dirty: new Map(), sceneDirty: true, pending: false, last: 0, minGap: maxFps > 0 ? 1000 / maxFps : 0, bytes: 0, frames: 0, skipped: 0, inflight: 0 };
        this.r.layers.forEach((l) => { if (l.kind === 'image' && this._wants(c, l)) c.dirty.set(l.key, { x: 0, y: 0, w: l.iw, h: l.ih }); });
        this.clients.add(c);
        ws.on('drain', () => this._schedule(c));
        ws.on('message', (m) => { if (m && m.t === 'ack') { c.inflight = Math.max(0, c.inflight - (m.n || 1)); this._schedule(c); } });
        ws.on('close', () => this.clients.delete(c));
        this._schedule(c);
        return c;
    }

    _schedule(c) {
        if (c.pending) return;
        c.pending = true;
        const wait = Math.max(0, c.last + c.minGap - Date.now());
        if (wait > 0) setTimeout(() => this._flush(c), wait); else setImmediate(() => this._flush(c));
    }

    _flush(c) {
        c.pending = false;
        if (!c.ws.open) return;
        if (c.ws.buffered > HIGH_WATER || c.inflight >= MAX_IN_FLIGHT) { c.skipped++; return; }      // 'drain' or the next ack tries again
        c.last = Date.now();
        if (c.sceneDirty) {
            c.sceneDirty = false;
            const layers = this.r.meta().filter((l) => c.target === 'all' || l.target === c.target);
            const s = JSON.stringify({ t: 'scene', layers });
            c.ws.send(s); c.bytes += s.length; c.inflight++;
        }
        c.dirty.forEach((box, key) => {
            const l = this.r.layers.get(key);
            if (!l || !l.image) return;
            const msg = crop(l, box);
            c.ws.sendBinary(msg); c.bytes += msg.length; c.frames++; c.inflight++;
        });
        c.dirty.clear();
    }

    stats() {
        return Array.from(this.clients).map((c) => ({ target: c.target, role: c.ws.role, addr: c.ws.addr, frames: c.frames, bytes: c.bytes, skipped: c.skipped, buffered: c.ws.buffered }));
    }
}

module.exports = { Streamer };
