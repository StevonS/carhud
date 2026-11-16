/* navicon.js: turn arrows, instructions and distances for navigation (HUD, desk, phone).
 *   NavIcon.draw(ctx, x, y, size, step, color)   step: {type, modifier, exit}
 *   NavIcon.text(step)                           "Turn right onto Main St"
 *   NavIcon.dist(metres)                         "350 m", "1.2 km"
 */
(function () {
  'use strict';
  const ANGLE = { straight: 0, 'slight right': 40, right: 90, 'sharp right': 135, uturn: 180, 'slight left': -40, left: -90, 'sharp left': -135 };

  function angleOf(s) {
    if (!s) return 0;
    if (s.type === 'depart' || s.type === 'continue' && !s.modifier) return 0;
    return ANGLE[s.modifier] === undefined ? 0 : ANGLE[s.modifier];
  }

  function arrow(ctx, size, deg, color) {
    const w = size * 0.13, a = deg * Math.PI / 180;
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = w; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const by = size * 0.45, my = deg === 180 || deg === -180 ? -size * 0.2 : -size * 0.05;
    ctx.beginPath(); ctx.moveTo(deg === 180 ? size * 0.18 : 0, by);
    if (Math.abs(deg) === 180) {
      ctx.lineTo(size * 0.18, my); ctx.arc(0, my, size * 0.18, 0, Math.PI, true); ctx.lineTo(-size * 0.18, size * 0.15);
      ctx.stroke();
      head(ctx, -size * 0.18, size * 0.22, Math.PI, size, color);
      return;
    }
    ctx.lineTo(0, my);
    const len = size * 0.36, ex = Math.sin(a) * len, ey = my - Math.cos(a) * len;
    ctx.quadraticCurveTo(0, my - len * 0.35, ex * 0.92, ey + Math.cos(a) * len * 0.08);
    ctx.stroke();
    head(ctx, ex, ey, a, size, color);
  }

  function head(ctx, x, y, a, size, color) {
    const h = size * 0.2;
    ctx.save(); ctx.translate(x, y); ctx.rotate(a);
    ctx.beginPath(); ctx.moveTo(0, -h * 0.9); ctx.lineTo(h * 0.75, h * 0.25); ctx.lineTo(-h * 0.75, h * 0.25); ctx.closePath();
    ctx.fillStyle = color; ctx.fill(); ctx.restore();
  }

  function draw(ctx, x, y, size, s, color) {
    ctx.save(); ctx.translate(x + size / 2, y + size / 2);
    color = color || '#fff';
    if (!s) { ctx.restore(); return; }
    if (s.type === 'arrive') {
      ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = size * 0.1;
      ctx.beginPath(); ctx.arc(0, -size * 0.08, size * 0.22, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, -size * 0.08, size * 0.08, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-size * 0.12, size * 0.12); ctx.lineTo(0, size * 0.42); ctx.lineTo(size * 0.12, size * 0.12); ctx.fill();
    } else if (/roundabout|rotary/.test(s.type)) {
      ctx.strokeStyle = color; ctx.lineWidth = size * 0.09;
      ctx.beginPath(); ctx.arc(0, size * 0.02, size * 0.2, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = size * 0.11; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(0, size * 0.46); ctx.lineTo(0, size * 0.22); ctx.stroke();
      const a = angleOf(s) * Math.PI / 180;
      const sx = Math.sin(a) * size * 0.2, sy = size * 0.02 - Math.cos(a) * size * 0.2;
      const ex = Math.sin(a) * size * 0.4, ey = size * 0.02 - Math.cos(a) * size * 0.4;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
      head(ctx, ex, ey, a, size * 0.8, color);
      if (s.exit) { ctx.fillStyle = color; ctx.font = '700 ' + Math.round(size * 0.2) + 'px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(s.exit, 0, size * 0.03); }
    } else {
      arrow(ctx, size, angleOf(s), color);
    }
    ctx.restore();
  }

  const DIRS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
  function text(s) {
    if (!s) return '';
    const onto = s.name ? ' onto ' + s.name : '';
    const m = s.modifier || '';
    switch (s.type) {
      case 'depart': return 'Head ' + (s.bearing !== undefined ? DIRS[Math.round(s.bearing / 45) % 8] : 'off') + (s.name ? ' on ' + s.name : '');
      case 'arrive': return 'Arrive at your destination' + (m && m !== 'straight' ? ', on the ' + m.replace('slight ', '') : '');
      case 'merge': return 'Merge' + (m ? ' ' + m.replace('slight ', '') : '') + onto;
      case 'on ramp': return 'Take the ramp' + (m && /left|right/.test(m) ? ' on the ' + m.replace(/slight |sharp /, '') : '') + onto;
      case 'off ramp': return 'Take the exit' + (m && /left|right/.test(m) ? ' on the ' + m.replace(/slight |sharp /, '') : '') + onto;
      case 'fork': return 'Keep ' + (m.replace('slight ', '') || 'straight') + ' at the fork' + onto;
      case 'end of road': return 'At the end of the road, turn ' + m.replace(/slight |sharp /, '') + onto;
      case 'roundabout': case 'rotary': case 'roundabout turn': return 'At the roundabout, take the ' + ordinal(s.exit || 1) + ' exit' + onto;
      case 'exit roundabout': case 'exit rotary': return 'Exit the roundabout' + onto;
      case 'new name': case 'continue': return (m === 'straight' || !m ? 'Continue' : 'Keep ' + m.replace('slight ', '')) + onto;
      default: return m === 'uturn' ? 'Make a U-turn' + onto : m === 'straight' ? 'Continue straight' + onto : 'Turn ' + m + onto;
    }
  }
  function ordinal(n) { return n + (['th', 'st', 'nd', 'rd'][((n % 100) - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th'); }

  function dist(m) {
    if (m === null || m === undefined || !isFinite(m)) return '';
    if (m < 1000) return (m < 100 ? Math.round(m / 10) * 10 : Math.round(m / 50) * 50) + ' m';
    return (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' km';
  }

  window.NavIcon = { draw, text, dist };
})();
