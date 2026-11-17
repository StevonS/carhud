/* control.js: the CarHUD control panel (/) */
(function () {
  'use strict';
  const { api, connect, fmt, $, h, DRIVE } = CarHud;

  const SIGNALS = [
    // key, label, min, max, step, unit, decimals
    ['rpm', 'RPM', 0, 8000, 50, 'rpm', 0], ['speed', 'Speed', 0, 260, 1, 'km/h', 0],
    ['coolant', 'Coolant', -20, 130, 1, '°C', 0], ['oil', 'Oil', -20, 150, 1, '°C', 0],
    ['boost', 'Boost', 0, 2.5, 0.05, 'bar', 2], ['torque', 'Torque', 0, 800, 10, 'Nm', 0],
    ['pedal', 'Pedal', 0, 100, 1, '%', 0], ['gLong', 'G long', -1.5, 1.5, 0.05, 'g', 2], ['gLat', 'G lat', -1.5, 1.5, 0.05, 'g', 2],
    ['afr', 'AFR', 9, 22, 0.1, ':1', 1], ['fuel', 'Fuel rail', 0, 300, 5, 'bar', 0], ['knock', 'Knock', 0, 12, 0.5, '°', 1],
    ['burn', 'Fuel rate', 0, 60, 0.5, 'L/h', 1],
  ];
  const PRESETS = {
    'Parked': { rpm: 0, speed: 0, gear: 0, pedal: 0, boost: 0, gLong: 0 },
    'Idle': { rpm: 850, speed: 0, gear: 0, pedal: 0, boost: 0, gLong: 0 },
    'City 50': { rpm: 1900, speed: 50, gear: 3, pedal: 15, boost: 0.1, gLong: 0 },
    'Highway 110': { rpm: 2600, speed: 110, gear: 6, pedal: 20, boost: 0.2, gLong: 0 },
    'Pull 3rd': { rpm: 6400, speed: 115, gear: 3, pedal: 100, boost: 1.4, gLong: 0.45 },
    'Shift light': { rpm: 6900, speed: 120, gear: 3, pedal: 100, boost: 1.5, gLong: 0.4 },
    'Hard brake': { rpm: 2200, speed: 60, gear: 3, pedal: 0, boost: 0, gLong: -0.9 },
    'Cold engine': { rpm: 2500, speed: 40, gear: 2, coolant: 30, oil: 25 },
    'Overheat': { coolant: 121, oil: 135, rpm: 3000, speed: 80, gear: 4 },
    'Overboost': { boost: 2.3, rpm: 5500, speed: 100, gear: 3, pedal: 100 },
    'Lean': { afr: 19.6, rpm: 4500, speed: 90, gear: 3, pedal: 80 },
    'Knock': { knock: 7, rpm: 4800, speed: 95, gear: 3, pedal: 90 },
  };
  const SRC_NOTES = {
    auto: 'Auto: OBD when the adapter answers, else the phone\'s GPS while it shares, else Demo.',
    demo: 'Demo: the HUD app\'s own 22 s loop (a drive, then each alert). It changes screens by itself; use Hold or Manual to stay on one.',
    manual: 'Manual: the HUD shows exactly the values below and holds them until you change them.',
    obd: 'OBD: live values from the car through the USB adapter. Engine off reads as parked.',
    gps: 'GPS: speed and G from the phone app sharing its location. The gear shows 1 while moving (GPS can\'t tell the gear).',
  };

  let st = {}, values = {}, settings = null;

  /* ---------- live view ---------- */
  const stage = $('#stage');
  const view = new HudView($('#c'), { target: 'hud' });
  view.onError = (t) => addLog({ level: 'error', time: Date.now(), text: 'preview: ' + t });
  const prefs = (() => { try { return JSON.parse(localStorage.getItem('carhud.view') || '{}'); } catch (e) { return {}; } })();
  const savePrefs = () => { try { localStorage.setItem('carhud.view', JSON.stringify(prefs)); } catch (e) { /* private mode */ } };
  [['oOutlines', 'outlines'], ['oBackdrop', 'backdrop'], ['oBmw', 'bmw']].forEach(([id, k]) => {
    const el = $('#' + id); el.checked = !!prefs[k]; view.set(k, el.checked);
    el.onchange = () => { view.set(k, el.checked); prefs[k] = el.checked; savePrefs(); };
  });
  [['oMirror', 'mirror'], ['oNative', 'native']].forEach(([id, k]) => {
    const el = $('#' + id); el.checked = !!prefs[k]; stage.classList.toggle(k, el.checked);
    el.onchange = () => { stage.classList.toggle(k, el.checked); prefs[k] = el.checked; savePrefs(); };
  });
  $('#target').value = prefs.target || 'hud'; view.setTarget($('#target').value);
  $('#fps').value = String(prefs.fps || 0);
  $('#bShot').onclick = () => { const a = h('a', { href: view.screenshot(), download: 'carhud-' + view.opts.target + '-' + Date.now() + '.png' }); a.click(); };

  const pix = connect({ target: view.opts.target, data: false, fps: Number($('#fps').value) || 0 }, {
    message: (m) => view.message(m), binary: (b) => view.binary(b),
  });
  $('#target').onchange = () => { prefs.target = $('#target').value; savePrefs(); view.setTarget(prefs.target); pix.reopen({ target: prefs.target }); };
  $('#fps').onchange = () => { prefs.fps = Number($('#fps').value); savePrefs(); pix.reopen({ fps: prefs.fps }); };
  setInterval(() => {
    const s = view.stats;
    $('#stat').textContent = s.fps + ' redraws/s · ' + s.kbps + ' KB/s · rtt ' + (pix.rtt === null ? '--' : pix.rtt + ' ms');
    $('#age').textContent = s.age === null ? '' : 'frame age ' + s.age + ' ms';
  }, 500);

  /* ---------- data link ---------- */
  const link = connect({ log: true }, {
    message: onMessage,
    open: () => { logEl.innerHTML = ''; pill('#pLink', 'ok', 'connected'); },      // the server sends the log history again
    close: () => pill('#pLink', 'bad', 'server gone'),
  });
  function pill(sel, cls, text) { const e = $(sel); e.className = 'pill ' + cls; e.textContent = text; }

  function onMessage(m) {
    if (m.t === 'state') { st = m; renderState(); }
    else if (m.t === 'values') { values = m; renderLive(); renderGear(); }
    else if (m.t === 'settings') { settings = m; renderSettings(); }
    else if (m.t === 'status') $('#appStatus').textContent = m.s;
    else if (m.t === 'log') addLog(m);
    else if (m.t === 'obd') renderObd(m.snap);
    else if (m.t === 'stats') renderStreams(m);
    else if (m.t === 'phone') { phoneSt = m.phone; renderPhone(); CarHudPair.handle(m); }
    else if (m.t === 'pair' || m.t === 'pair-done') CarHudPair.handle(m);
    else if (m.t === 'screens') { screensPanel.update(m); lcdPanel.reload(); }
    else if (m.t === 'nav') { navSt = m; renderPhone(); }
  }

  /* ---------- screens and sound ---------- */
  const screensPanel = CarHudPanels.screens($('#screensBox'));
  CarHudPanels.audio($('#audioBox'));
  const lcdPanel = CarHudPanels.lcd($('#lcdBox'));

  /* ---------- phone & navigation ---------- */
  let phoneSt = null, navSt = null;
  function renderPhone() {
    if (!phoneSt) return;
    const bt = phoneSt.bt || {}, d = (bt.devices || []).find((x) => x.connected), g = phoneSt.gps, md = bt.media;
    const n = navSt && navSt.active ? navSt : null;
    kv($('#phoneInfo'), [
      ['Bluetooth', !bt.available ? 'not running' + (bt.error ? ': ' + bt.error : '') : !bt.adapter ? 'no adapter' : (bt.adapter.discoverable ? 'visible to phones' : 'on') + ' as ' + bt.adapter.name],
      ['Last problem', bt.error && Date.now() - bt.errorAt < 300000 ? bt.error : null],
      ['Last pairing', phoneSt.lastPair ? phoneSt.lastPair.name + (phoneSt.lastPair.passkey ? ' (code ' + phoneSt.lastPair.passkey + ')' : '') + (phoneSt.lastPair.done ? (phoneSt.lastPair.ok ? ': paired' : ': failed') : ': in progress') : null],
      ['Phone', d ? d.name + (d.battery !== null && d.battery !== undefined ? ' · ' + d.battery + '%' : '') + (d.notifications ? ' · notifications' : '') : (bt.devices || []).length ? 'paired, not connected' : 'none paired'],
      ['Playing', md && md.title ? md.title + (md.artist ? ' · ' + md.artist : '') + ' (' + md.status + ')' : null],
      ['GPS', g ? (g.fresh ? (g.sim ? 'simulated · ' : 'from the phone · ') + Math.round(g.speed || 0) + ' km/h' + (g.accuracy ? ' · ±' + Math.round(g.accuracy) + ' m' : '') : 'last fix ' + Math.round(g.age / 1000) + ' s ago') : 'no phone sharing'],
      ['Route', n ? (n.dest || 'destination') + ' · ' + NavIcon.dist(n.left) + ' left' + (n.offRoute ? ' · OFF ROUTE' : '') : null],
      ['Next', n && n.next ? NavIcon.dist(n.next.distance) + ': ' + (n.next.text || NavIcon.text(n.next)) : n && n.arrived ? 'arrived' : null],
    ]);
    $('#bDrive').textContent = phoneSt.simulating ? 'Stop test drive' : 'Test drive';
  }
  $('#bPair').onclick = () => CarHudPair.startPairing();
  $('#bNotif').onclick = () => api('/api/phone/test-notification', {});
  $('#bCall').onclick = () => api('/api/phone/test-notification', { call: true });
  $('#bEnd').onclick = () => api('/api/phone/route/clear', {});
  $('#bDrive').onclick = () => api('/api/phone/simulate', { speed: phoneSt && phoneSt.simulating ? 0 : 60 });
  $('#bRoute').onclick = () => {
    const g = phoneSt && phoneSt.gps, lat = g ? g.lat : 43.3616, lon = g ? g.lon : -80.3144;
    const dLat = 400 / 111320, dLon = 400 / (111320 * Math.cos(lat * Math.PI / 180));
    const c = [[lon, lat], [lon, lat + dLat], [lon + dLon, lat + dLat], [lon + dLon, lat], [lon, lat]];
    const names = ['Test Ave', 'First St', 'Second St', 'Third St'];
    const steps = [{ type: 'depart', modifier: '', name: names[0], location: c[0], bearing: 0 }]
      .concat([1, 2, 3].map((i) => ({ type: 'turn', modifier: 'right', name: names[i], location: c[i], distance: 400 })))
      .concat([{ type: 'arrive', modifier: '', name: '', location: c[4] }]);
    steps.forEach((st) => { st.text = NavIcon.text(st); });
    api('/api/phone/route', { route: { dest: { name: 'Test loop', lat, lon }, coords: c, steps, distance: 1600, duration: 120 } });
  };

  /* ---------- state: source, drive, pills ---------- */
  function renderState() {
    pill('#pApp', st.app === 'running' ? 'ok' : st.app === 'building' ? 'warn' : 'bad', 'app ' + st.app);
    pill('#pSrc', 'accent', (st.auto ? 'auto: ' : '') + st.source);
    const o = st.obd || {};
    pill('#pObd', o.state === 'live' ? 'ok' : o.state === 'waiting' || o.state === 'connecting' ? 'warn' : '', 'obd ' + o.state);
    $('#pObd').title = o.detail || '';
    $('#ver').textContent = 'v' + st.version;
    document.querySelectorAll('#srcSeg button[data-s]').forEach((b) => b.classList.toggle('on', st.auto ? b.dataset.s === 'auto' : b.dataset.s === st.source));
    $('#srcNote').textContent = SRC_NOTES[st.auto ? 'auto' : st.source] + (st.auto ? ' Now: ' + st.source + '.' : '');
    document.querySelectorAll('#driveSeg button').forEach((b) => b.classList.toggle('on', String(st.drive) === b.dataset.v));
    renderSignals();
  }
  document.querySelectorAll('#srcSeg button[data-s]').forEach((b) => { b.onclick = () => api('/api/source', { source: b.dataset.s }); });
  $('#bHold').onclick = () => api('/api/hold', {});
  DRIVE.forEach(([v, name]) => $('#driveSeg').append(h('button', { 'data-v': String(v), onclick: () => api('/api/drive', { value: v }) }, name)));
  $('#bReload').onclick = () => api('/api/displays/reload', {});
  $('#bRestart').onclick = () => api('/api/app/restart', {});
  $('#bRebuild').onclick = () => api('/api/app/restart', { rebuild: true });
  $('#bObdRe').onclick = () => api('/api/obd/reconnect', {});
  $('#bReset').onclick = () => api('/api/manual', { reset: true });

  /* ---------- signals ---------- */
  let sendTimer = null, pending = {};
  function sendManual(vals) {
    Object.assign(pending, vals);
    if (sendTimer) return;
    sendTimer = setTimeout(() => { const v = pending; pending = {}; sendTimer = null; api('/api/manual', { values: v }); }, 50);
  }
  const gearRow = $('#gears');
  [['P', 0], ['R', -1], ...[1, 2, 3, 4, 5, 6, 7, 8].map((g) => [String(g), g])].forEach(([t, g]) => {
    gearRow.append(h('button', { 'data-g': String(g), onclick: () => { const m = Object.assign({}, st.manual, { gear: g }); st.manual = m; sendManual({ gear: g }); } }, t));
  });
  const sigBox = $('#sigs');
  SIGNALS.forEach(([k, label, min, max, step, unit]) => {
    const range = h('input', { type: 'range', min, max, step, id: 'r_' + k });
    const num = h('input', { type: 'number', min, max, step, id: 'n_' + k });
    const set = (v) => { range.value = v; num.value = v; sendManual({ [k]: Number(v) }); };
    range.oninput = () => set(range.value);
    num.onchange = () => set(num.value);
    sigBox.append(h('div', { class: 'sig', id: 'sig_' + k }, h('span', {}, label, ' ', h('span', { class: 'unit' }, unit)), range, num, h('span', { class: 'live', id: 'l_' + k }, '--')));
  });
  Object.keys(PRESETS).forEach((name) => $('#presets').append(h('button', { onclick: () => api('/api/manual', { values: PRESETS[name] }) }, name)));

  function renderSignals() {
    const m = st.manual || {}, manual = st.source === 'manual';
    SIGNALS.forEach(([k]) => {
      const r = $('#r_' + k), n = $('#n_' + k);
      if (document.activeElement !== r && document.activeElement !== n && m[k] !== undefined) { r.value = m[k]; n.value = m[k]; }
      $('#sig_' + k).classList.toggle('off', !manual);
    });
    document.querySelectorAll('#gears button').forEach((b) => b.classList.toggle('on', manual && Number(b.dataset.g) === m.gear));
  }

  /** the "live" column: what the HUD app sees now (and, with OBD, the car's readings) */
  function renderLive() {
    const hud = values.hud || {}, d = values.derived || {};
    SIGNALS.forEach(([k, , , , , , dec]) => {
      let v = hud[k];
      if ((v === undefined || v === null) && values.source === 'obd') v = d[k];
      if ((v === undefined || v === null) && values.source === 'manual' && st.manual) v = st.manual[k];
      $('#l_' + k).textContent = fmt(v, dec);
    });
    if (st.source !== 'manual') document.querySelectorAll('#gears button').forEach((b) => b.classList.toggle('on', Number(b.dataset.g) === Math.round(hud.gear)));
  }

  /* ---------- HUD settings: the app's own settings page ---------- */
  function renderSettings() {
    const box = $('#settings');
    box.innerHTML = ''; box.classList.remove('muted');
    settings.schema.filter((s) => s.key !== 'demo').forEach((s) => {      // demo data is the Source buttons' job
      if (s.showWhen && !s.showWhen.some((w) => Object.keys(w).every((k) => settings.values[k] === w[k]))) return;
      let ctl;
      if (s.type === 'bool') {
        ctl = h('input', { type: 'checkbox' }); ctl.checked = !!settings.values[s.key];
        ctl.onchange = () => api('/api/setting', { key: s.key, value: ctl.checked });
      } else {
        ctl = h('select');
        const opts = s.type === 'choice' ? s.options : s.steps.map((v) => [v, v + (s.unit ? ' ' + s.unit : '')]);
        opts.forEach(([v, t]) => { const o = h('option', { value: v }, t); if (v === settings.values[s.key]) o.selected = true; ctl.append(o); });
        ctl.onchange = () => api('/api/setting', { key: s.key, value: s.type === 'number' ? Number(ctl.value) : ctl.value });
      }
      box.append(h('div', { class: 'srow' }, h('span', {}, s.label), ctl));
    });
  }

  /* ---------- OBD ---------- */
  function kv(box, pairs) { box.innerHTML = ''; pairs.forEach(([k, v]) => box.append(h('span', {}, k), h('span', {}, v === undefined || v === null || v === '' ? '--' : v))); }
  function renderObd(s) {
    const i = s.info || {};
    kv($('#obdInfo'), [
      ['State', s.state + (s.detail ? ' · ' + s.detail : '')], ['Device', i.device], ['Adapter', (i.version || '') + (i.baud ? ' @ ' + i.baud : '')],
      ['Protocol', i.protocol], ['Battery', i.volts ? i.volts + ' V' : null], ['Poll rate', s.roundHz ? s.roundHz + ' rounds/s' + (s.multi ? ' (multi-PID)' : '') : null],
    ]);
    const tb = $('#obdTable tbody'); tb.innerHTML = '';
    s.pids.forEach((p) => tb.append(h('tr', {}, h('td', { class: 'mono' + (p.dead ? ' dead' : '') }, p.pid), h('td', { class: p.dead ? 'dead' : '' }, p.label),
      h('td', { class: 'num' }, p.value === undefined ? '--' : CarHud.num(p.value) + ' ' + p.unit), h('td', { class: 'num' }, p.hz === null ? '' : p.hz))));
    if (!s.pids.length) tb.append(h('tr', {}, h('td', { colspan: 4, class: 'muted' }, 'no car connected yet')));
  }
  function renderGear() {
    if (!st.gearRatios) return;
    const d = values.derived || {};
    kv($('#obdGear'), [
      ['rpm per km/h', values.ratio === null || values.ratio === undefined ? '--' : values.ratio + (d.gear ? '  →  gear ' + d.gear : '')],
      ['Gear ratios', st.gearRatios.join(', ') + (st.gearRatiosSet ? '' : '  (generic: set yours with carhud gears)')],
    ]);
  }

  /* ---------- streams ---------- */
  function renderStreams(m) {
    const tb = $('#streams'); tb.innerHTML = '';
    m.streams.forEach((s) => tb.append(h('tr', {}, h('td', {}, s.role), h('td', { class: 'mono' }, String(s.addr || '').replace('::ffff:', '')), h('td', {}, s.target),
      h('td', { class: 'num' }, s.frames), h('td', { class: 'num' }, (s.bytes / 1048576).toFixed(1) + ' MB'), h('td', { class: 'num' }, s.skipped), h('td', { class: 'num' }, Math.round(s.buffered / 1024) + ' KB'))));
  }

  /* ---------- log ---------- */
  const logEl = $('#log');
  let logPaused = false; const held = [];
  const LEVEL = { info: 0, warn: 1, error: 2 };
  function logVisible(e) {
    const f = $('#logFilter').value.toLowerCase();
    return LEVEL[e.level] >= LEVEL[$('#logLevel').value] && (!f || e.text.toLowerCase().includes(f));
  }
  function addLog(e) {
    if (logPaused) { held.push(e); return; }
    const div = h('div', { class: e.level }, h('span', { class: 't' }, new Date(e.time).toTimeString().slice(0, 8) + ' '), e.text);
    div._e = e;
    if (!logVisible(e)) div.style.display = 'none';
    const atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 6;
    logEl.append(div);
    while (logEl.childNodes.length > 800) logEl.firstChild.remove();
    if (atBottom) logEl.scrollTop = logEl.scrollHeight;
  }
  const refilter = () => { logEl.childNodes.forEach((d) => { d.style.display = logVisible(d._e) ? '' : 'none'; }); logEl.scrollTop = logEl.scrollHeight; };
  $('#logLevel').onchange = refilter; $('#logFilter').oninput = refilter;
  $('#logPause').onclick = () => { logPaused = !logPaused; $('#logPause').textContent = logPaused ? 'Resume' : 'Pause'; if (!logPaused) held.splice(0).forEach(addLog); };
  $('#logClear').onclick = () => { logEl.innerHTML = ''; };
})();
