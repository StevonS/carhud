'use strict';
/**
 * A small WebSocket server (RFC 6455), no dependencies: text and binary out, text in, ping/pong.
 * Each connection is a Client with send(), sendBinary(), a 'message' callback and the raw socket,
 * whose writableLength the streamer reads for backpressure.
 */
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(opcode, payload) {
    const len = payload.length;
    let head;
    if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
    else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[1] = 127; head.writeUInt32BE(Math.floor(len / 4294967296), 2); head.writeUInt32BE(len >>> 0, 6); }
    head[0] = 0x80 | opcode;
    return [head, payload];
}

class Client extends EventEmitter {
    constructor(socket, req) {
        super();
        this.socket = socket;
        this.req = req;
        this.open = true;
        this.buf = Buffer.alloc(0);
        this.frags = [];
        socket.setNoDelay(true);
        socket.on('data', (d) => this._data(d));
        socket.on('close', () => this._closed());
        socket.on('error', () => this._closed());
        socket.on('drain', () => this.emit('drain'));
    }
    get buffered() { return this.socket.writableLength; }
    _write(opcode, payload) {
        if (!this.open) return false;
        const [h, p] = frame(opcode, payload);
        this.socket.cork();
        this.socket.write(h);
        const ok = this.socket.write(p);
        this.socket.uncork();
        return ok;
    }
    send(obj) { return this._write(1, Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8')); }
    sendBinary(buf) { return this._write(2, buf); }
    close() { if (this.open) { this._write(8, Buffer.alloc(0)); this.socket.end(); } this._closed(); }
    _closed() { if (!this.open) return; this.open = false; this.emit('close'); }
    _data(d) {
        this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
        for (;;) {
            if (this.buf.length < 2) return;
            const b0 = this.buf[0], b1 = this.buf[1];
            let len = b1 & 0x7f, off = 2;
            if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
            else if (len === 127) { if (this.buf.length < 10) return; len = this.buf.readUInt32BE(2) * 4294967296 + this.buf.readUInt32BE(6); off = 10; }
            if (len > 1e6) { this.socket.destroy(); return; }
            const masked = !!(b1 & 0x80);
            const need = off + (masked ? 4 : 0) + len;
            if (this.buf.length < need) return;
            let payload = this.buf.slice(off + (masked ? 4 : 0), need);
            if (masked) {
                const mask = this.buf.slice(off, off + 4);
                payload = Buffer.from(payload);
                for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
            }
            this.buf = this.buf.slice(need);
            const op = b0 & 0x0f, fin = !!(b0 & 0x80);
            if (op === 8) { this.close(); return; }
            if (op === 9) { this._write(10, payload); continue; }
            if (op === 10) continue;
            if (op === 1 || op === 2 || op === 0) {
                this.frags.push(payload);
                if (!fin) continue;
                const msg = Buffer.concat(this.frags); this.frags = [];
                if (op === 2) continue;      // binary in: not used
                let m; try { m = JSON.parse(msg.toString('utf8')); } catch (e) { continue; }
                this.emit('message', m);
            }
        }
    }
}

/** Attach to an http.Server: onClient(client, req) for each upgrade on a path accepted by test(url). */
function attach(server, test, onClient) {
    server.on('upgrade', (req, socket) => {
        const key = req.headers['sec-websocket-key'];
        if (!key || !test(req.url) || String(req.headers.upgrade).toLowerCase() !== 'websocket') { socket.destroy(); return; }
        const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
        onClient(new Client(socket, req), req);
    });
}

module.exports = { attach };
