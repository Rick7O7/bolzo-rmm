// Schlanke SVG-Diagramme: Sparkline für Karten, Liniendiagramm mit Hover für die Detailansicht.
import { fmtClock, esc } from './ui.js';

const SERIES = [
  { key: 1, label: 'CPU', color: 'var(--series-cpu)' },
  { key: 2, label: 'RAM', color: 'var(--series-mem)' },
];

export function sparkline(points, { key = 1, color = 'var(--series-cpu)', height = 38 } = {}) {
  const w = 300, h = height;
  if (!points || points.length < 2) {
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><line x1="0" y1="${h - 1}" x2="${w}" y2="${h - 1}" stroke="var(--grid)" stroke-width="1"/></svg>`;
  }
  const n = points.length;
  const xy = points.map((p, i) => [(i / (n - 1)) * w, h - 2 - (Math.min(100, p[key]) / 100) * (h - 4)]);
  const line = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `0,${h} ${line} ${w},${h}`;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polygon points="${area}" fill="${color}" opacity="0.12"/>
    <polyline points="${line}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
  </svg>`;
}

// Liniendiagramm CPU/RAM in % über die Zeit. Gibt eine update(points)-Funktion zurück.
export function lineChart(container, { height = 220 } = {}) {
  container.classList.add('chart-box');
  container.innerHTML = `
    <div class="chart-legend">${SERIES.map((s) => `<span><span class="sw" style="background:${s.color}"></span>${s.label}<b data-v="${s.key}">–</b></span>`).join('')}</div>
    <svg width="100%" height="${height}" style="display:block;margin-top:10px;overflow:visible"></svg>
    <div class="chart-tip"></div>`;
  const svg = container.querySelector('svg');
  const tip = container.querySelector('.chart-tip');
  let pts = [];
  const pad = { l: 36, r: 10, t: 8, b: 24 };

  function geom() {
    const W = svg.clientWidth || 600;
    const H = height;
    const t0 = pts.length ? pts[0][0] : Date.now() - 60e3;
    const t1 = pts.length ? Math.max(pts[pts.length - 1][0], t0 + 60e3) : Date.now();
    const x = (t) => pad.l + ((t - t0) / (t1 - t0)) * (W - pad.l - pad.r);
    const y = (v) => pad.t + (1 - Math.min(100, Math.max(0, v)) / 100) * (H - pad.t - pad.b);
    return { W, H, t0, t1, x, y };
  }

  function draw() {
    const { W, H, t0, t1, x, y } = geom();
    let g = '';
    for (const v of [0, 25, 50, 75, 100]) {
      g += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="${v === 0 ? 'var(--axis)' : 'var(--grid)'}" stroke-width="1"/>`;
      g += `<text x="${pad.l - 8}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="var(--muted)" class="num">${v}</text>`;
    }
    // Zeitachse: ca. 5 Beschriftungen
    const span = t1 - t0;
    const step = [60e3, 120e3, 300e3, 600e3, 900e3, 1800e3].find((s) => span / s <= 6) || 3600e3;
    for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
      g += `<text x="${x(t)}" y="${H - 6}" text-anchor="middle" font-size="11" fill="var(--muted)" class="num">${fmtClock(t)}</text>`;
    }
    for (const s of SERIES) {
      if (pts.length < 2) continue;
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[s.key]).toFixed(1)}`).join('');
      g += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    }
    g += `<g class="hover" style="display:none"><line y1="${pad.t}" y2="${H - pad.b}" stroke="var(--text-2)" stroke-width="1" stroke-dasharray="3 3"/>${SERIES.map((s) => `<circle r="4.5" fill="${s.color}" stroke="var(--surface)" stroke-width="2" data-k="${s.key}"/>`).join('')}</g>`;
    g += `<rect x="${pad.l}" y="0" width="${Math.max(0, W - pad.l - pad.r)}" height="${H}" fill="transparent" class="hit"/>`;
    svg.innerHTML = g;
    if (!pts.length) {
      svg.insertAdjacentHTML('beforeend', `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="var(--muted)" font-size="13">Noch keine Messwerte</text>`);
    }
    const last = pts[pts.length - 1];
    for (const s of SERIES) container.querySelector(`[data-v="${s.key}"]`).textContent = last ? `${Math.round(last[s.key])} %` : '–';
  }

  svg.addEventListener('mousemove', (e) => {
    if (!pts.length) return;
    const { x, y } = geom();
    const rect = svg.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    let best = pts[0];
    for (const p of pts) if (Math.abs(x(p[0]) - mx) < Math.abs(x(best[0]) - mx)) best = p;
    const hg = svg.querySelector('.hover');
    hg.style.display = '';
    const px = x(best[0]);
    hg.querySelector('line').setAttribute('x1', px);
    hg.querySelector('line').setAttribute('x2', px);
    for (const c of hg.querySelectorAll('circle')) {
      c.setAttribute('cx', px);
      c.setAttribute('cy', y(best[c.dataset.k]));
    }
    tip.innerHTML = `<div class="t">${esc(new Date(best[0]).toLocaleTimeString('de-DE'))}</div>` +
      SERIES.map((s) => `<div class="r"><span class="sw" style="width:8px;height:8px;border-radius:2px;background:${s.color}"></span>${s.label}<b>${best[s.key].toFixed(1).replace('.', ',')} %</b></div>`).join('');
    tip.style.display = 'block';
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.min(rect.width - tw, Math.max(0, px + 14 > rect.width - tw ? px - tw - 14 : px + 14))}px`;
    tip.style.top = `${svg.offsetTop + 10}px`;
  });
  svg.addEventListener('mouseleave', () => {
    const hg = svg.querySelector('.hover');
    if (hg) hg.style.display = 'none';
    tip.style.display = 'none';
  });

  const ro = new ResizeObserver(() => draw());
  ro.observe(container);

  return {
    update(points) {
      pts = points;
      draw();
    },
    destroy() { ro.disconnect(); },
  };
}
