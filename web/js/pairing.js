/* pairing.js: Bluetooth pairing on any CarHUD screen (desk, control panel, phone app).
 *   CarHudPair.handle(m)        feed it the server's messages (pair, pair-done, phone)
 *   CarHudPair.startPairing()   opens the 3-minute pairing window, says what to do next or what's wrong
 *   CarHudPair.toast(text, kind, ms)
 * Needs carhud.js.
 */
(function () {
  'use strict';
  const CSS = `
  #chPair { position: fixed; inset: 0; background: rgba(5,6,8,.92); display: none; place-items: center; z-index: 1000; text-align: center; padding: 20px; }
  #chPair.show { display: grid; }
  #chPair .code { font-size: 56px; font-weight: 800; letter-spacing: .12em; color: #ff8a2a; font-variant-numeric: tabular-nums; margin: 10px 0; }
  #chPair button { font: 600 19px system-ui, sans-serif; padding: 14px 30px; margin: 10px 6px 0; border-radius: 12px; border: 1px solid #2a2e35; background: #1b1e23; color: #e4e6ea; }
  #chPair button.yes { background: #ff8a2a; border-color: #ff8a2a; color: #111; }
  #chToasts { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); display: flex; flex-direction: column; gap: 8px; z-index: 999; width: min(560px, 94vw); pointer-events: none; }
  .chToast { pointer-events: auto; background: rgba(27,30,35,.97); border: 1px solid #2a2e35; border-left: 4px solid #4fa3ff; border-radius: 10px; padding: 10px 14px; color: #e4e6ea; font: 15px/1.4 system-ui, sans-serif; box-shadow: 0 8px 30px rgba(0,0,0,.5); }
  .chToast.ok { border-left-color: #4cd07d; } .chToast.bad { border-left-color: #ff5a4f; }`;
  let ready = false, shownFor = null;

  function init() {
    if (ready) return; ready = true;
    const st = document.createElement('style'); st.textContent = CSS; document.head.append(st);
    const d = document.createElement('div'); d.id = 'chPair';
    d.innerHTML = '<div><div style="font-size:18px;color:#e4e6ea">Pair with <b id="chPairName"></b>?</div>' +
      '<div style="color:#8b919b">Check the phone shows the same code.</div><div class="code" id="chPairCode"></div>' +
      '<button class="yes" id="chPairYes">Pair</button><button id="chPairNo">Decline</button></div>';
    document.body.append(d);
    const t = document.createElement('div'); t.id = 'chToasts'; document.body.append(t);
    d.querySelector('#chPairYes').onclick = () => { CarHud.api('/api/phone/pair', { accept: true }); hide(); };
    d.querySelector('#chPairNo').onclick = () => { CarHud.api('/api/phone/pair', { accept: false }); hide(); };
  }

  function toast(text, kind, ms) {
    init();
    const el = document.createElement('div'); el.className = 'chToast ' + (kind || ''); el.textContent = text;
    el.onclick = () => el.remove();
    const box = document.getElementById('chToasts'); box.append(el);
    while (box.children.length > 3) box.firstChild.remove();
    setTimeout(() => el.remove(), ms || 6000);
  }
  function ask(p) {
    init();
    if (shownFor === p.address + p.passkey) return;
    shownFor = p.address + p.passkey;
    document.getElementById('chPairName').textContent = p.name;
    document.getElementById('chPairCode').textContent = p.passkey || '';
    document.getElementById('chPair').classList.add('show');
  }
  function hide() { shownFor = null; const d = document.getElementById('chPair'); if (d) d.classList.remove('show'); }

  function handle(m) {
    if (m.t === 'pair') {
      const p = m.pair;
      if (p.auto) toast('Pairing with ' + p.name + (p.passkey ? ' · code ' + p.passkey + ': tap Pair on the phone' : ''), 'ok', 10000);
      else ask(p);
    } else if (m.t === 'pair-done') {
      hide();
      toast(m.done.ok ? 'Paired ✓  Music and notifications will connect by themselves.' : 'Pairing declined or timed out.', m.done.ok ? 'ok' : 'bad', 6000);
    } else if (m.t === 'phone') {
      if (m.phone.pairing) ask(m.phone.pairing); else hide();
    }
  }

  async function startPairing() {
    const r = await CarHud.api('/api/phone/discoverable', { on: true, seconds: 180 });
    if (r.error) toast(r.error, 'bad', 12000);
    else toast('Visible as "' + r.name + '" for 3 minutes. On the phone: Settings → Bluetooth → ' + r.name + ', then tap Pair.', 'ok', 15000);
    return r;
  }

  window.CarHudPair = { handle, toast, startPairing };
})();
