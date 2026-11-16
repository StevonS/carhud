/* carhud.js: the connection to the carhud server, shared by every page.
 *
 *   const link = CarHud.connect({ target: 'hud', data: false, log: false }, {
 *     message(m) {}, binary(buf) {}, open() {}, close() {}
 *   });
 *   CarHud.api('/api/source', { source: 'manual' }).then(state => ...)
 *
 * Reconnects by itself, measures the round trip, and reloads the page when the server was updated.
 */
(function () {
  'use strict';
  const base = window.CARHUD_BASE || '';

  function api(path, body) {
    const opts = body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
    return fetch(base + path, opts).then((r) => r.json().catch(() => ({})));
  }

  function connect(opts, handlers) {
    opts = opts || {}; handlers = handlers || {};
    function makeUrl() {
      const q = [];
      if (opts.target) q.push('target=' + opts.target);
      if (opts.fps) q.push('fps=' + opts.fps);
      if (opts.data === false) q.push('data=0');
      if (opts.log) q.push('log=1');
      if (opts.role) q.push('role=' + opts.role);
      const loc = base ? new URL(base) : location;
      return (loc.protocol === 'https:' ? 'wss://' : 'ws://') + loc.host + '/ws?' + q.join('&');
    }
    const link = { open: false, rtt: null, build: null, ws: null, closedSince: Date.now() };
    let pingTimer = null, retry = 500;

    /* displays acknowledge every picture, so the server never queues more than a few ahead */
    function ack(ws) { if (opts.target) { try { ws.send('{"t":"ack"}'); } catch (e) { /* closing */ } } }
    function start() {
      const ws = new WebSocket(makeUrl());
      ws.binaryType = 'arraybuffer';
      link.ws = ws;
      ws.onopen = () => {
        link.open = true; retry = 500; link.closedSince = null;
        pingTimer = setInterval(() => { try { ws.send(JSON.stringify({ t: 'ping', id: performance.now() })); } catch (e) { /* closing */ } }, 2000);
        handlers.open && handlers.open();
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') { handlers.binary && handlers.binary(ev.data); ack(ws); return; }
        const m = JSON.parse(ev.data);
        if (m.t === 'scene') ack(ws);
        if (m.t === 'pong') { link.rtt = Math.round(performance.now() - m.id); link.skew = m.server - Date.now(); return; }
        if (m.t === 'hello') {
          if (link.build && link.build !== m.build && opts.autoReload !== false) { location.reload(); return; }
          link.build = m.build;
        }
        if (m.t === 'reload' && opts.autoReload !== false) { location.reload(); return; }
        handlers.message && handlers.message(m);
      };
      ws.onclose = () => {
        clearInterval(pingTimer);
        if (link.open) { link.closedSince = Date.now(); handlers.close && handlers.close(); }
        link.open = false;
        if (link.stopped) return;
        setTimeout(start, retry); retry = Math.min(retry * 2, 4000);
      };
    }
    /** change target / fps etc. and reconnect with them */
    link.reopen = (changes) => { Object.assign(opts, changes || {}); retry = 50; if (link.ws) link.ws.close(); };
    /** stop for good (no reconnecting) */
    link.close = () => { link.stopped = true; if (link.ws) link.ws.close(); };
    start();
    return link;
  }

  /* little helpers the pages share */
  const fmt = (v, d) => (v === null || v === undefined || !isFinite(v) ? '--' : Number(v).toFixed(d === undefined ? 0 : d));
  const $ = (s, root) => (root || document).querySelector(s);
  const h = (tag, attrs, ...kids) => {
    const e = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => { if (k === 'class') e.className = v; else if (k.startsWith('on')) e[k] = v; else if (v !== false && v !== null && v !== undefined) e.setAttribute(k, v); });
    kids.flat().forEach((k) => e.append(k instanceof Node ? k : document.createTextNode(String(k))));
    return e;
  };
  const DRIVE = [[null, 'Not sent'], [4, 'Comfort'], [1, 'Sport'], [2, 'Sport+'], [7, 'Eco Pro']];
  const SOURCE_NAMES = { auto: 'Auto', demo: 'Demo', manual: 'Manual', obd: 'OBD' };
  const num = (v) => (typeof v !== 'number' ? '--' : Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10);

  window.CarHud = { api, connect, fmt, num, $, h, DRIVE, SOURCE_NAMES };
})();
