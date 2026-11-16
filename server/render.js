'use strict';
/**
 * The stand-in for BMW's cluster-render service that the EVA HUD app draws through.
 * Adapted from idrive7-EVAHUD bench/server.js (MIT, Copyright (c) 2026 bimmer-lab, DukeAPenguin).
 *
 * Listens on a Unix socket speaking cluster-render protocol v1 (u32 LE length, u8 type 'J'/'F'/'M').
 * Keeps every layer and its pixels, and emits:
 *   'scene'             (layers changed: position, visibility, uniforms...)
 *   'pixels' (layer, box)   (image pixels changed inside box {x,y,w,h})
 *   'log'    (level, text)
 */
const fs = require('fs');
const net = require('net');
const { EventEmitter } = require('events');

const TARGETS = { hud: [800, 480], map: [1088, 480], panel: [1920, 720] };
const CLASSES = ['ambient', 'content', 'overlay', 'alert'];
const MAX_MSG = 5529664;
const LAYER_LIMIT = 8;          // cluster-render refuses a client's 9th layer
const TOTAL_LAYER_LIMIT = 32;

class Renderer extends EventEmitter {
    constructor(sockPath) {
        super();
        this.sockPath = sockPath;
        this.layers = new Map();
        this.nextConn = 1;
        this.version = 0;          // bumps on each scene change
        this._sceneTimer = null;
    }

    meta() {
        return Array.from(this.layers.values()).map((l) => ({
            key: l.key, ref: l.ref, app: l.app, kind: l.kind, target: l.target,
            class: l.class, z: l.z, x: l.x, y: l.y, w: l.w, h: l.h, visible: l.visible, opacity: l.opacity,
            exclusive: l.exclusive, iw: l.iw, ih: l.ih, fs: l.fs, time: l.time, uniforms: l.uniforms, sx: l.sx, sy: l.sy, rotate: l.rotate,
        }));
    }

    _changed() {
        if (this._sceneTimer) return;
        this._sceneTimer = setTimeout(() => { this._sceneTimer = null; this.version++; this.emit('scene'); }, 16);
    }

    listen(cb) {
        try { fs.unlinkSync(this.sockPath); } catch (e) { /* not there */ }
        this.server = net.createServer((sock) => this._conn(sock));
        this.server.listen(this.sockPath, cb);
    }

    close() { try { this.server.close(); fs.unlinkSync(this.sockPath); } catch (e) { /* gone */ } }

    _conn(sock) {
        const self = this;
        const conn = this.nextConn++;
        const st = { app: '?', hello: false, buf: Buffer.alloc(0) };
        const bad = (why) => this.emit('log', 'error', 'protocol [' + st.app + ']: ' + why);
        const refuse = (op, ref, reason) => { bad(op + ' ref ' + ref + ': ' + reason); writeEv({ ev: 'error', op, ref, reason }); };
        function writeEv(obj) {
            const body = Buffer.from(JSON.stringify(obj), 'utf8');
            const m = Buffer.alloc(5 + body.length);
            m.writeUInt32LE(body.length + 1, 0); m[4] = 0x4a; body.copy(m, 5);
            sock.write(m);
        }

        sock.on('data', (d) => {
            st.buf = st.buf.length ? Buffer.concat([st.buf, d]) : d;
            let off = 0;
            while (st.buf.length - off >= 5) {
                const len = st.buf.readUInt32LE(off);
                if (len < 1 || len > MAX_MSG) { bad('message length ' + len + ' out of range, closing'); sock.destroy(); return; }
                if (st.buf.length - off < 4 + len) break;
                const type = st.buf[off + 4];
                const body = st.buf.slice(off + 5, off + 4 + len);
                off += 4 + len;
                try { handle(type, body); } catch (e) { bad('handler threw: ' + e.stack); }
            }
            st.buf = st.buf.slice(off);
        });
        sock.on('error', () => {});
        sock.on('close', () => {
            let n = 0;
            this.layers.forEach((l, k) => { if (l.conn === conn) { this.layers.delete(k); n++; } });
            this.emit('log', 'info', 'renderer: ' + st.app + ' disconnected, dropped ' + n + ' layer(s)');
            this._changed();
        });

        function handle(type, body) {
            if (type === 0x4a) return onJson(body);
            if (!st.hello) return bad('binary message before hello');
            if (type === 0x46) return onFrame(body);
            if (type === 0x4d) return bad('mesh geometry received; meshes are not drawn');
            bad('unknown message type 0x' + type.toString(16));
        }

        function onJson(body) {
            let m;
            try { m = JSON.parse(body.toString('utf8')); } catch (e) { return bad('JSON message does not parse: ' + e.message); }
            if (m.op === 'hello') {
                st.hello = true; st.app = m.app || '?';
                self.emit('log', 'info', 'renderer: hello from ' + st.app);
                writeEv({ ev: 'hello', backend: 'carhud', targets: Object.keys(TARGETS).join(',') });
                return;
            }
            if (!st.hello) return bad(m.op + ' before hello');
            const key = conn + ':' + m.ref;
            const l = self.layers.get(key);
            switch (m.op) {
                case 'layer': {
                    if (!TARGETS[m.target]) return refuse('layer', m.ref, 'unknown target ' + m.target);
                    if (m.class && CLASSES.indexOf(m.class) < 0) return refuse('layer', m.ref, 'unknown class ' + m.class);
                    if (self.layers.size >= TOTAL_LAYER_LIMIT) return refuse('layer', m.ref, 'too many layers');
                    if (Array.from(self.layers.values()).filter((x) => x.conn === conn).length >= LAYER_LIMIT) return refuse('layer', m.ref, 'too many layers');
                    const nl = {
                        key, conn, ref: m.ref, app: st.app, kind: m.kind, target: m.target,
                        class: m.class || 'content', z: m.z || 0, x: m.x || 0, y: m.y || 0, w: m.w || 0, h: m.h || 0,
                        visible: m.visible === undefined ? 1 : m.visible, opacity: m.opacity === undefined ? 1 : m.opacity,
                        exclusive: m.exclusive || 0, uniforms: {},
                        sx: m.sx === undefined ? 1 : m.sx, sy: m.sy === undefined ? 1 : m.sy, rotate: m.rotate || 0,
                    };
                    if (m.kind === 'image') {
                        if (!(m.iw > 0 && m.ih > 0 && m.iw <= 1920 && m.ih <= 720)) return refuse('layer', m.ref, 'image iw/ih out of range');
                        nl.iw = m.iw; nl.ih = m.ih; nl.image = Buffer.alloc(m.iw * m.ih * 4);
                    } else if (m.kind === 'effect') {
                        if (!m.fs) return refuse('layer', m.ref, 'effect without fs');
                        nl.fs = m.fs; nl.time = !!m.time;
                    }
                    self.layers.set(key, nl);
                    writeEv({ ev: 'layer', ref: m.ref, state: 'shown' });
                    self._changed();
                    return;
                }
                case 'set':
                    if (!l) return refuse('set', m.ref, 'no such layer');
                    ['class', 'z', 'x', 'y', 'w', 'h', 'visible', 'exclusive', 'opacity', 'sx', 'sy', 'rotate'].forEach((k) => { if (m[k] !== undefined) l[k] = m[k]; });
                    self._changed();
                    return;
                case 'drop':
                    if (!l) return refuse('drop', m.ref, 'no such layer');
                    self.layers.delete(key);
                    self._changed();
                    return;
                case 'uniform': {
                    if (!l) return refuse('uniform', m.ref, 'no such layer');
                    if (l.kind !== 'effect') return refuse('uniform', m.ref, 'uniform on a ' + l.kind + ' layer');
                    const v = String(m.v).trim().split(/\s+/).map(Number);
                    if (v.some((n) => !isFinite(n))) return refuse('uniform', m.ref, 'non-numeric value');
                    l.uniforms[m.name] = v;
                    self._changed();
                    return;
                }
                case 'status':
                    writeEv({ ev: 'status', text: 'carhud: ' + self.layers.size + ' layers' });
                    return;
                default:
                    bad('op "' + m.op + '" not handled');
            }
        }

        function onFrame(body) {
            if (body.length < 14) return bad('frame message too short');
            const ref = body.readUInt32LE(0);
            const n = body.readUInt16LE(12);
            const l = self.layers.get(conn + ':' + ref);
            if (!l) return bad('frame for unknown ref ' + ref);
            if (l.kind !== 'image') return bad('frame for a ' + l.kind + ' layer');
            const head = 14 + n * 8;
            const px = body.slice(head);
            let box;
            if (n === 0) {
                if (px.length !== l.image.length) return bad('whole frame for ref ' + ref + ' is the wrong size');
                px.copy(l.image);
                box = { x: 0, y: 0, w: l.iw, h: l.ih };
            } else {
                let o = 0, x0 = 1e9, y0 = 1e9, x1 = 0, y1 = 0;
                for (let i = 0; i < n; i++) {
                    const x = body.readUInt16LE(14 + i * 8), y = body.readUInt16LE(16 + i * 8);
                    const w = body.readUInt16LE(18 + i * 8), h = body.readUInt16LE(20 + i * 8);
                    if (x + w > l.iw || y + h > l.ih) return bad('dirty rect off the image on ref ' + ref);
                    for (let r = 0; r < h; r++) { px.copy(l.image, ((y + r) * l.iw + x) * 4, o, o + w * 4); o += w * 4; }
                    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h);
                }
                if (o !== px.length) return bad('dirty rects for ref ' + ref + ' carry the wrong byte count');
                box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
            }
            if (box.w > 0 && box.h > 0) self.emit('pixels', l, box);
        }
    }
}

module.exports = { Renderer, TARGETS };
