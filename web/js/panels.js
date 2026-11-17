/* panels.js: the Screens and Audio controls, shared by the control panel and the desk's System app.
 *   const sp = CarHudPanels.screens(boxElement);  sp.update(screensMessage)
 *   const ap = CarHudPanels.audio(boxElement);    (loads and refreshes itself)
 * Needs carhud.js (and pairing.js for the little messages, if loaded).
 */
(function () {
  'use strict';
  const { api, h } = CarHud;
  const say = (t, kind) => (window.CarHudPair ? CarHudPair.toast(t, kind, 6000) : console.log(t));
  const KIND = { usb: 'USB sound card (for the car\'s AUX)', jack: '3.5 mm headphone jack', hdmi: 'HDMI', other: '' };

  function screens(box) {
    let st = null;
    const head = h('div', { class: 'row', style: 'margin-bottom:8px' },
      h('button', { onclick: () => api('/api/screens/identify', {}) }, 'Identify'),
      h('button', { onclick: () => api('/api/screens/relayout', {}).then(() => say('Re-doing the screen layout...', 'ok')) }, 'Re-do layout'),
      h('span', { class: 'muted', style: 'font-size:12px' }, 'Identify shows each display\'s name on it for 5 s.'));
    const list = h('div');
    box.append(head, list);
    const set = (output, changes) => api('/api/screens', Object.assign({ output }, changes)).then((r) => { if (r.error) say(r.error, 'bad'); });

    function render() {
      list.innerHTML = '';
      if (!st) return;
      if (!st.x) { list.append(h('div', { class: 'muted' }, 'No displays found: the Pi\'s desktop isn\'t running, or nothing is plugged in.')); return; }
      if (!st.outputs.length) { list.append(h('div', { class: 'muted' }, 'No displays connected.')); return; }
      st.outputs.forEach((o) => {
        const a = st.assignments[o.name] || {};
        const sel = h('select', { onchange: () => set(o.name, { screen: sel.value }) });
        Object.entries(st.types).forEach(([k, v]) => { const op = h('option', { value: k }, v); if (k === a.screen) op.selected = true; sel.append(op); });
        const rot = h('select', { title: 'Turn this display', onchange: () => set(o.name, { rotate: rot.value }) });
        st.rotations.forEach((r) => { const op = h('option', { value: r }, r === 'normal' ? 'not turned' : 'turned ' + r); if (r === a.rotate) op.selected = true; rot.append(op); });
        const opts = h('div', { class: 'row', style: 'margin-top:6px;font-size:13px' });
        if (a.screen === 'hud') {
          [['mirror', 'Mirror'], ['flip', 'Flip'], ['bmw', 'BMW speed zone']].forEach(([k, t]) => {
            const cb = h('input', { type: 'checkbox' }); cb.checked = !!a[k];
            cb.onchange = () => set(o.name, { [k]: cb.checked });
            opts.append(h('label', { style: 'display:inline-flex;gap:5px;align-items:center;color:var(--dim)' }, cb, t));
          });
        }
        if (a.screen === 'url') {
          const inp = h('input', { type: 'text', placeholder: 'http://...', value: a.url || '', style: 'flex:1;min-width:160px' });
          opts.append(inp, h('button', { onclick: () => set(o.name, { url: inp.value }) }, 'Show'));
        }
        list.append(h('div', { style: 'padding:9px 0;border-bottom:1px solid var(--line)' },
          h('div', { class: 'row' },
            h('b', { style: 'min-width:64px' }, o.name),
            h('span', { class: 'muted', style: 'font-size:12px;min-width:70px' }, o.width ? o.width + '×' + o.height : 'off'),
            sel, rot),
          opts));
      });
    }
    return { update(m) { st = m; render(); } };
  }

  function audio(box) {
    const sel = h('select');
    const vol = h('input', { type: 'range', min: 0, max: 100, class: 'grow' });
    const note = h('div', { class: 'note' });
    box.append(
      h('div', { class: 'row' }, sel, h('button', { onclick: () => api('/api/audio/test', {}).then(() => say('Test sound played', 'ok')) }, 'Test sound')),
      h('div', { class: 'row', style: 'margin-top:10px' }, h('span', { class: 'muted' }, 'Volume'), vol, h('span', { class: 'muted', id: 'volVal' })),
      note);
    let dragging = false;
    sel.onchange = () => api('/api/audio', { output: sel.value }).then((r) => { if (r.error) say(r.error, 'bad'); else { say('Sound now goes to ' + label(r, r.current), 'ok'); render(r); } });
    vol.oninput = () => { dragging = true; box.querySelector('#volVal').textContent = vol.value + '%'; };
    vol.onchange = () => api('/api/audio/volume', { value: Number(vol.value) }).then((r) => { dragging = false; if (r.error) say(r.error, 'bad'); });
    function label(info, id) { const o = (info.outputs || []).find((x) => x.id === id); return o ? (KIND[o.kind] || o.name) : id; }
    function render(info) {
      sel.innerHTML = '';
      if (!info.available) { sel.append(h('option', {}, 'not available')); note.textContent = info.error || ''; return; }
      const cur = (info.outputs || []).find((x) => x.id === info.current);
      sel.append(h('option', { value: 'auto' }, 'Automatic: ' + (cur ? KIND[cur.kind] || cur.name : 'none')));
      info.outputs.forEach((o) => { const op = h('option', { value: o.id }, (KIND[o.kind] || o.name) + ' (' + o.id + ')'); sel.append(op); });
      sel.value = info.choice === 'auto' ? 'auto' : info.choice;
      if (!dragging) { vol.disabled = info.volume === null || info.volume === undefined || isNaN(info.volume); vol.value = info.volume || 0; box.querySelector('#volVal').textContent = vol.disabled ? 'set on the phone or car' : info.volume + '%'; }
      const usb = info.outputs.some((o) => o.kind === 'usb');
      note.textContent = 'Phone music and the desk\'s Music app play here. Automatic uses a USB sound card when one is plugged in (the cleanest way into the car\'s AUX), otherwise the 3.5 mm jack.' +
        (usb ? ' A whine that rises with engine speed is a ground loop: a ground loop isolator on the AUX cable fixes it.' : ' No USB sound card plugged in.');
    }
    const load = () => api('/api/audio').then(render).catch(() => {});
    load(); setInterval(load, 10000);
    return { reload: load };
  }

  window.CarHudPanels = { screens, audio };
})();
