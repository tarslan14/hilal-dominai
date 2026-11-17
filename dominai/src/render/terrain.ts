// Flat "theatre map" of one region in the style of a shaded-relief atlas sheet.
// The game ships no elevation data (it runs offline), so the relief is PROCEDURAL: ridged noise that is
// stable per location, stronger in countries flagged as rough terrain. Borders, coasts, names and troop
// numbers are real game data; the individual peaks and valleys are illustrative.
import type { Polygon, World } from '../data/world';
import { fmtTroops } from '../engine/state';
import type { GameState } from '../engine/types';

const hash = (x: number, y: number) => {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
const smooth = (t: number) => t * t * (3 - 2 * t);
function vnoise(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const u = smooth(x - xi), v = smooth(y - yi);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
/** Ridged fractal noise in 0..1: sharp crests, branching valleys. Each octave is rotated and the
 *  input is domain-warped so the value-noise grid never shows through. */
function ridged(x: number, y: number): number {
  const wx = x + 1.3 * (vnoise(x * 0.5 + 11.7, y * 0.5 + 3.1) - 0.5);
  const wy = y + 1.3 * (vnoise(x * 0.5 - 7.9, y * 0.5 + 23.4) - 0.5);
  let sum = 0, amp = 0.5, norm = 0, px = wx, py = wy;
  for (let o = 0; o < 5; o++) {
    const n = 1 - Math.abs(2 * vnoise(px + o * 17.3, py - o * 9.1) - 1);
    sum += n * n * amp;
    norm += amp;
    amp *= 0.48;
    const rx = px * 0.8 - py * 0.6, ry = px * 0.6 + py * 0.8; // rotate ~37 degrees
    px = rx * 1.97; py = ry * 1.97;
  }
  return sum / norm;
}

export interface TerrainMark {
  id: string;
  kind: 'target' | 'own' | 'enemy';
}

export function drawTerrain(canvas: HTMLCanvasElement, world: World, s: GameState, focusId: string, marks: TerrainMark[] = []) {
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext('2d')!;
  const focus = world.byId[focusId];
  // frame: the focus country's main landmass plus a generous margin
  let bb = focus.bboxes[0];
  for (const b of focus.bboxes) if ((b[2] - b[0]) * (b[3] - b[1]) > (bb[2] - bb[0]) * (bb[3] - bb[1])) bb = b;
  const lat0 = (bb[1] + bb[3]) / 2, lon0 = (bb[0] + bb[2]) / 2;
  const kx = Math.max(0.2, Math.cos((lat0 * Math.PI) / 180));
  let spanLat = Math.max(7, (bb[3] - bb[1]) * 1.7);
  spanLat = Math.max(spanLat, ((bb[2] - bb[0]) * 1.7 * kx * H) / W);
  spanLat = Math.min(spanLat, 120);
  const ppd = H / spanLat; // pixels per degree of latitude
  const X = (lon: number) => W / 2 + (lon - lon0) * kx * ppd;
  const Y = (lat: number) => H / 2 - (lat - lat0) * ppd;
  const lonSpan = W / (kx * ppd);

  const pathOf = (polys: Polygon[]) => {
    const p = new Path2D();
    for (const poly of polys) {
      // bring the polygon to the copy of the world nearest to the frame
      let mid = 0;
      for (const q of poly[0]) mid += q[0];
      mid /= poly[0].length;
      const shift = Math.round((lon0 - mid) / 360) * 360;
      for (const ring of poly) {
        for (let i = 0; i < ring.length; i++) {
          const x = X(ring[i][0] + shift), y = Y(ring[i][1]);
          if (i === 0) p.moveTo(x, y);
          else p.lineTo(x, y);
        }
        p.closePath();
      }
    }
    return p;
  };
  const near = world.countries.filter((c) => {
    let d = Math.abs(c.centroid[0] - lon0);
    if (d > 180) d = 360 - d;
    return c.bboxes.some((b) => b[3] > lat0 - spanLat && b[1] < lat0 + spanLat) && (d < lonSpan + 40 || c.bboxes.some((b) => b[2] - b[0] > 60));
  });
  const paths = new Map(near.map((c) => [c.id, pathOf(c.polygons)]));
  const neutral = pathOf(world.neutral.filter((poly) => poly[0][0][1] > lat0 - spanLat * 1.5 && poly[0][0][1] < lat0 + spanLat * 1.5));

  // 1. id mask: which country is under each pixel
  const mask = document.createElement('canvas');
  mask.width = W; mask.height = H;
  const mc = mask.getContext('2d', { willReadFrequently: true })!;
  mc.fillStyle = 'rgb(255,255,254)';
  mc.fill(neutral, 'evenodd');
  near.forEach((c, i) => {
    mc.fillStyle = `rgb(${(i + 1) & 255},${(i + 1) >> 8},255)`;
    mc.fill(paths.get(c.id)!, 'evenodd');
  });
  const md = mc.getImageData(0, 0, W, H).data;

  // 2. relief
  const img = ctx.createImageData(W, H);
  const out = img.data;
  const fq = Math.min(1.1, Math.max(0.12, 26 / ppd)); // one main ridge every ~40 px, whatever the zoom
  const height = (lon: number, lat: number, rough: number) => {
    const base = ridged(lon * fq, lat * fq * 1.25);
    const broad = vnoise(lon * 0.11 + 40, lat * 0.11 - 12); // mountain belts vs plains
    return Math.min(1, base * (0.3 + rough * 0.42 + broad * 0.6));
  };
  const dd = 1.6 / ppd; // sampling offset for the hillshade, in degrees
  for (let py = 0; py < H; py++) {
    const lat = lat0 - (py - H / 2) / ppd;
    for (let px = 0; px < W; px++) {
      const i = (py * W + px) * 4;
      const lon = lon0 + (px - W / 2) / (kx * ppd);
      const land = md[i + 3] > 128;
      if (!land) {
        const n = vnoise(lon * 0.8, lat * 0.8);
        out[i] = 196 + n * 12; out[i + 1] = 226 + n * 8; out[i + 2] = 238 + n * 6; out[i + 3] = 255;
        continue;
      }
      const idx = md[i + 2] === 255 ? (md[i] | (md[i + 1] << 8)) - 1 : -1;
      const rough = idx >= 0 && idx < near.length ? near[idx].terrain : 0.3;
      const h = height(lon, lat, rough);
      const shade = Math.max(0.62, Math.min(1.22, 0.92 + (height(lon - dd, lat + dd, rough) - height(lon + dd, lat - dd, rough)) * 3.4));
      let r: number, g: number, b: number;
      if (h < 0.07) { r = 122; g = 192; b = 196; } // valley floors and rivers
      else if (h < 0.34) { const t = (h - 0.07) / 0.27; r = 150 + t * 34; g = 204 + t * 12; b = 150 + t * 12; }
      else if (h < 0.64) { const t = (h - 0.34) / 0.3; r = 184 + t * 30; g = 216 + t * 10; b = 162 + t * 40; }
      else { const t = Math.min(1, (h - 0.64) / 0.2); r = 214 + t * 36; g = 226 + t * 26; b = 202 + t * 53; } // rock to snow
      out[i] = Math.min(255, r * shade); out[i + 1] = Math.min(255, g * shade); out[i + 2] = Math.min(255, b * shade); out[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // 3. coast glow, borders, highlights
  ctx.lineJoin = 'round';
  for (const c of near) {
    ctx.strokeStyle = 'rgba(70, 110, 130, 0.55)';
    ctx.lineWidth = 1.1;
    ctx.stroke(paths.get(c.id)!);
  }
  const col = { target: '#c8281e', own: '#0b7f95', enemy: '#c8281e' } as const;
  for (const m of marks) {
    const p = paths.get(m.id);
    if (!p) continue;
    ctx.fillStyle = m.kind === 'own' ? 'rgba(0, 200, 230, 0.16)' : 'rgba(215, 60, 40, 0.16)';
    ctx.fill(p, 'evenodd');
    ctx.strokeStyle = col[m.kind];
    ctx.lineWidth = m.kind === 'target' ? 3 : 2;
    if (m.kind !== 'target') ctx.setLineDash([7, 4]);
    ctx.stroke(p);
    ctx.setLineDash([]);
  }
  if (!marks.some((m) => m.id === focusId)) {
    ctx.strokeStyle = '#8a5a12';
    ctx.lineWidth = 2.5;
    ctx.stroke(paths.get(focusId)!);
  }

  // 4. names and garrisons
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const c of near) {
    let lon = c.centroid[0];
    lon += Math.round((lon0 - lon) / 360) * 360;
    const x = X(lon), y = Y(c.centroid[1]);
    if (x < 20 || x > W - 20 || y < 14 || y > H - 14) continue;
    const big = c.id === focusId || marks.some((m) => m.id === c.id);
    const size = big ? 15 : Math.max(9, Math.min(13, Math.sqrt(c.area) * ppd * 0.045 + 8));
    if (!big && Math.sqrt(c.area) * ppd < 260) continue; // too small to label at this scale
    ctx.font = `600 ${size}px "Palatino Linotype", Georgia, serif`;
    const name = c.name.toUpperCase();
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.strokeText(name, x, y);
    ctx.fillStyle = '#3a2a1c';
    ctx.fillText(name, x, y);
    const t = s.countries[c.id];
    if (big && t) {
      const label = fmtTroops(t.troops) + ' troops';
      ctx.font = '600 11px "Palatino Linotype", Georgia, serif';
      const w = ctx.measureText(label).width + 14;
      const mk = marks.find((m) => m.id === c.id);
      ctx.fillStyle = mk?.kind === 'own' ? 'rgba(6, 70, 84, 0.9)' : mk ? 'rgba(120, 24, 18, 0.9)' : 'rgba(40, 28, 15, 0.88)';
      ctx.fillRect(x - w / 2, y + size * 0.8, w, 17);
      ctx.fillStyle = '#f3e6c8';
      ctx.fillText(label, x, y + size * 0.8 + 9);
    }
  }
  // scale bar
  const km = [50, 100, 200, 500, 1000, 2000].find((k) => (k / 111) * ppd > 70) ?? 2000;
  const len = (km / 111) * ppd;
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.fillRect(12, H - 30, len + 16, 22);
  ctx.strokeStyle = '#3a2a1c'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(20, H - 14); ctx.lineTo(20 + len, H - 14); ctx.moveTo(20, H - 18); ctx.lineTo(20, H - 10); ctx.moveTo(20 + len, H - 18); ctx.lineTo(20 + len, H - 10); ctx.stroke();
  ctx.fillStyle = '#3a2a1c'; ctx.font = '600 10px "Palatino Linotype", Georgia, serif';
  ctx.fillText(`${km} km`, 20 + len / 2, H - 22);
}
