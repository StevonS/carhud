// A viewer that stops reading for a while (like a laptop on bad Wi-Fi), then reads again.
// Checks the server queued only a bounded amount and the first frames after resuming are fresh.
const net = require('net');
const port = Number(process.argv[2] || 8078);
const s = net.connect(port, '127.0.0.1', () => {
    s.write('GET /ws?target=hud&data=0 HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
});
let buf = Buffer.alloc(0), resumed = 0, ages = [];
// a display acknowledges each message (client frames are masked)
function ack() { const p = Buffer.from('{"t":"ack"}'); const f = Buffer.alloc(6 + p.length); f[0] = 0x81; f[1] = 0x80 | p.length; for (let i = 0; i < p.length; i++) f[6 + i] = p[i]; s.write(f); }
s.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
        const i = buf.indexOf('\r\n\r\n'); if (buf.slice(0, 4).toString() === 'HTTP' && i > 0) { buf = buf.slice(i + 4); continue; }
        if (buf.length < 2) return;
        let len = buf[1] & 127, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) return; len = buf.readUInt32BE(6); off = 10; }
        if (buf.length < off + len) return;
        const p = buf.slice(off, off + len), op = buf[0] & 15; buf = buf.slice(off + len);
        if (op === 2 || (op === 1 && p.toString().includes('"scene"'))) ack();
        if (op === 2 && resumed) { const kl = p[1]; ages.push(Date.now() - p.readDoubleLE(2 + kl)); }
    }
});
setTimeout(() => { s.pause(); console.log('paused reading for 8 s'); }, 1500);
setTimeout(() => { resumed = Date.now(); s.resume(); console.log('resumed'); }, 9500);
setTimeout(() => {
    const late = ages.slice(-10);
    console.log('frames after resuming:', ages.length, ' age of the last ones (ms):', late.join(' '));
    process.exit(0);
}, 13000);
