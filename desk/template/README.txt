Your own desk apps
==================

Every folder here is an app on the second screen's home screen. An app is a web page:

  my-app/
    app.json      { "name": "My app", "icon": "🚗", "order": 60 }
    index.html    the page (it fills the screen under the top bar)

Icons can be an emoji or an image file in the folder ("icon": "icon.png").
To link to another web page or local web app instead: { "name": "X", "type": "url", "url": "http://127.0.0.1:3000" }
Hide an app without deleting it: "hidden": true

Live data in your page (see hello/index.html):
  <script src="/js/carhud.js"></script>
  CarHud.connect({}, { message(m) { if (m.t === 'values') ... m.hud.rpm, m.hud.speed, m.obd.coolant ... } });
  CarHud.api('/api/source', { source: 'manual' })   any control-panel action

Go home from your page:  parent.postMessage({ carhud: 'home' }, '*')

Changes show after reloading the desk (carhud reload). CarHUD updates never touch this folder.
An app here with the same folder name as a built-in one (gauges, music...) replaces it.
