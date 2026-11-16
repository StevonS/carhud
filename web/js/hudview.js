/* hudview.js: draws what the HUD app draws, from the server's stream.
 *
 *   const view = new HudView(canvas, { target: 'hud', outlines: false, backdrop: false, bmw: false });
 *   view.message(m)   // JSON from the server (scene)
 *   view.binary(buf)  // pixel updates
 *
 * Image layers are the app's own RGBA pixels; effect layers run the app's GLSL shaders in WebGL.
 * Layers stack by class, then z, as cluster-render does.
 * Compositing adapted from idrive7-EVAHUD bench/page.html (MIT, Copyright (c) 2026 bimmer-lab, DukeAPenguin).
 */
(function () {
  'use strict';
  const CLASS_ORDER = { ambient: 0, content: 1, overlay: 2, alert: 3 };
  const TARGETS = { hud: [800, 480], map: [1088, 480], panel: [1920, 720] };
  const VS = 'attribute vec2 a_pos; varying vec2 v_uv; void main(){ v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5); gl_Position = vec4(a_pos, 0.0, 1.0); }';

  class HudView {
    constructor(canvas, opts) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.opts = Object.assign({ target: 'hud', outlines: false, backdrop: false, bmw: false }, opts || {});
      this.scene = [];
      this.images = new Map();
      this.dirty = true;
      this.stats = { redraws: 0, fps: 0, bytes: 0, kbps: 0, age: null, msgs: 0, mps: 0 };
      this._statT = performance.now(); this._r = 0; this._b = 0; this._m = 0;
      this.onError = null;
      this._initGl();
      this.setTarget(this.opts.target);
      const loop = (t) => { this._frame(t); requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
    }

    set(k, v) { this.opts[k] = v; this.dirty = true; }
    setTarget(t) {
      this.opts.target = t;
      const [w, h] = TARGETS[t] || TARGETS.hud;
      this.W = w; this.H = h; this.canvas.width = w; this.canvas.height = h;
      this.dirty = true;
    }

    message(m) {
      if (m.t !== 'scene') return;
      this.scene = m.layers;
      const keys = new Set(this.scene.map((l) => l.key));
      Array.from(this.images.keys()).forEach((k) => { if (!keys.has(k)) this.images.delete(k); });
      this.dirty = true;
    }

    binary(buf) {
      const dv = new DataView(buf);
      if (dv.getUint8(0) !== 1) return;
      const kl = dv.getUint8(1);
      let key = '';
      for (let i = 0; i < kl; i++) key += String.fromCharCode(dv.getUint8(2 + i));
      let o = 2 + kl;
      const sent = dv.getFloat64(o, true); o += 8;
      const iw = dv.getUint16(o, true), ih = dv.getUint16(o + 2, true), x = dv.getUint16(o + 4, true), y = dv.getUint16(o + 6, true);
      const w = dv.getUint16(o + 8, true), h = dv.getUint16(o + 10, true); o += 12;
      let c = this.images.get(key);
      if (!c) { c = document.createElement('canvas'); c.width = iw; c.height = ih; this.images.set(key, c); }
      if (c.width !== iw || c.height !== ih) { c.width = iw; c.height = ih; }
      if (w && h) c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(buf.slice(o, o + w * h * 4)), w, h), x, y);
      this._b += buf.byteLength; this._m++;
      this.stats.age = Date.now() - sent;
      this.dirty = true;
    }

    _initGl() {
      this.gl = null;
      this.programs = new Map();
      this.shaderErrors = new Set();
      try {
        this.glCanvas = document.createElement('canvas');
        const gl = this.glCanvas.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true, alpha: true });
        if (!gl) return;
        this.quad = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        this.gl = gl;
      } catch (e) { this.gl = null; }
    }

    _compile(fs) {
      if (this.programs.has(fs)) return this.programs.get(fs);
      const gl = this.gl;
      const mk = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
      const v = mk(gl.VERTEX_SHADER, VS), f = mk(gl.FRAGMENT_SHADER, fs);
      const p = gl.createProgram(); gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p);
      let e;
      if (!gl.getShaderParameter(f, gl.COMPILE_STATUS)) e = { err: 'shader does not compile: ' + gl.getShaderInfoLog(f) };
      else if (!gl.getProgramParameter(p, gl.LINK_STATUS)) e = { err: 'shader does not link: ' + gl.getProgramInfoLog(p) };
      else e = { prog: p };
      this.programs.set(fs, e);
      return e;
    }

    _effect(l, t) {
      if (!this.gl) return null;
      const gl = this.gl, e = this._compile(l.fs);
      if (e.err) { if (!this.shaderErrors.has(l.key)) { this.shaderErrors.add(l.key); this.onError && this.onError('layer ' + l.ref + ' ' + e.err); } return null; }
      const c = this.glCanvas;
      if (c.width !== Math.max(1, l.w)) c.width = Math.max(1, l.w);
      if (c.height !== Math.max(1, l.h)) c.height = Math.max(1, l.h);
      gl.viewport(0, 0, c.width, c.height);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(e.prog);
      const loc = gl.getAttribLocation(e.prog, 'a_pos');
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
      gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      const n = gl.getProgramParameter(e.prog, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) {
        const info = gl.getActiveUniform(e.prog, i), u = gl.getUniformLocation(e.prog, info.name);
        let v = l.uniforms[info.name];
        if (info.name === 'u_time' && l.time) v = [t / 1000];
        if (!v) continue;
        if (info.type === gl.FLOAT) gl.uniform1f(u, v[0]);
        else if (info.type === gl.FLOAT_VEC2) gl.uniform2fv(u, v.slice(0, 2));
        else if (info.type === gl.FLOAT_VEC3) gl.uniform3fv(u, v.slice(0, 3));
        else if (info.type === gl.FLOAT_VEC4) gl.uniform4fv(u, v.slice(0, 4));
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return c;
    }

    _frame(t) {
      const animated = this.scene.some((l) => l.kind === 'effect' && l.time && l.visible && l.target === this.opts.target);
      if (this.dirty || animated) {
        this.dirty = false;
        const ctx = this.ctx, W = this.W, H = this.H;
        ctx.clearRect(0, 0, W, H);
        if (this.opts.backdrop) this._road();
        const ls = this.scene.filter((l) => l.target === this.opts.target && l.visible)
          .sort((a, b) => (CLASS_ORDER[a.class] - CLASS_ORDER[b.class]) || (a.z - b.z));
        let start = 0;
        ls.forEach((l, i) => { if (l.exclusive) start = i; });
        ls.slice(start).forEach((l) => {
          ctx.save();
          ctx.globalAlpha = l.opacity === undefined ? 1 : l.opacity;
          ctx.translate(l.x + l.w / 2, l.y + l.h / 2);
          if (l.rotate) ctx.rotate(l.rotate * Math.PI / 180);
          ctx.scale(l.sx === undefined ? 1 : l.sx, l.sy === undefined ? 1 : l.sy);
          const c = l.kind === 'image' ? this.images.get(l.key) : l.kind === 'effect' ? this._effect(l, t) : null;
          if (c) ctx.drawImage(c, -l.w / 2, -l.h / 2, l.w, l.h);
          ctx.restore();
        });
        if (this.opts.target === 'hud' && this.opts.bmw) this._bmwSpeed();
        if (this.opts.outlines) {
          ctx.font = '11px monospace';
          ls.forEach((l) => {
            ctx.strokeStyle = 'rgba(79,163,255,.6)'; ctx.lineWidth = 1; ctx.strokeRect(l.x + .5, l.y + .5, l.w - 1, l.h - 1);
            ctx.fillStyle = 'rgba(79,163,255,.9)'; ctx.fillText('#' + l.ref + ' ' + l.kind + ' ' + l.class + '/' + l.z, l.x + 2, l.y - 3 < 9 ? l.y + l.h + 11 : l.y - 3);
          });
        }
        this._r++;
      }
      if (t - this._statT >= 1000) {
        const s = (t - this._statT) / 1000;
        this.stats.fps = Math.round(this._r / s); this.stats.kbps = Math.round(this._b / 1024 / s); this.stats.mps = Math.round(this._m / s);
        this._r = 0; this._b = 0; this._m = 0; this._statT = t;
      }
    }

    _road() {
      const ctx = this.ctx, g = ctx.createLinearGradient(0, 0, 0, this.H);
      g.addColorStop(0, '#2a3340'); g.addColorStop(0.45, '#56606b'); g.addColorStop(0.46, '#2b2d30'); g.addColorStop(1, '#151618');
      ctx.fillStyle = g; ctx.fillRect(0, 0, this.W, this.H);
    }

    /* where BMW's own speed readout sits on the car's HUD (the project's BMW_ZONE) */
    _bmwSpeed() {
      const ctx = this.ctx;
      ctx.save();
      ctx.fillStyle = '#ff2a2a'; ctx.fillRect(219, 327, 122, 3);
      ctx.fillStyle = '#fff'; ctx.font = '700 44px sans-serif'; ctx.textAlign = 'right'; ctx.fillText('120', 297, 377);
      ctx.font = '700 15px sans-serif'; ctx.textAlign = 'left'; ctx.fillText('km/h', 303, 350);
      ctx.fillRect(137, 320, 57, 62);
      ctx.fillStyle = '#000'; ctx.textAlign = 'center'; ctx.font = '700 22px sans-serif'; ctx.fillText('40', 165, 349);
      ctx.restore();
    }

    screenshot() { return this.canvas.toDataURL('image/png'); }
  }

  window.HudView = HudView;
})();
