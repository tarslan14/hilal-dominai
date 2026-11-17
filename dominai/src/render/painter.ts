import type { GeoCountry, Polygon, World } from '../data/world';

export type RGB = [number, number, number];

const OCEAN = '#06101c';
const NEUTRAL = '#1a222c';
const BORDER = 'rgba(4,10,18,0.9)';

/**
 * Paints countries onto an equirectangular canvas that is mapped onto the globe.
 * Only countries whose colour actually changed are repainted (lazy update).
 */
export class MapPainter {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private last = new Map<string, string>();
  private paths = new Map<string, Path2D>();
  dirty = true;

  constructor(private world: World, readonly width = 4096) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = width / 2;
    this.ctx = this.canvas.getContext('2d')!;
    for (const c of world.countries) this.paths.set(c.id, this.buildPath(c.polygons));
    this.paintBase();
  }

  private buildPath(polys: Polygon[]): Path2D {
    const W = this.canvas.width, H = this.canvas.height;
    const p = new Path2D();
    for (const poly of polys) {
      let lo = Infinity, hi = -Infinity;
      for (const q of poly[0]) { if (q[0] < lo) lo = q[0]; if (q[0] > hi) hi = q[0]; }
      // polygons that spill over the antimeridian are drawn a second time, shifted by 360 degrees
      const shifts = hi > 180 ? [0, -360] : lo < -180 ? [0, 360] : [0];
      for (const shift of shifts) for (const ring of poly) {
        for (let i = 0; i < ring.length; i++) {
          const x = ((ring[i][0] + shift + 180) / 360) * W;
          const y = ((90 - ring[i][1]) / 180) * H;
          if (i === 0) p.moveTo(x, y);
          else p.lineTo(x, y);
        }
        p.closePath();
      }
    }
    return p;
  }

  private paintBase() {
    const { ctx, canvas } = this;
    ctx.fillStyle = OCEAN;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // faint graticule for the "command room" look
    ctx.strokeStyle = 'rgba(60,110,150,0.10)';
    ctx.lineWidth = 1;
    for (let lon = -180; lon <= 180; lon += 15) {
      const x = ((lon + 180) / 360) * canvas.width;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
    }
    for (let lat = -75; lat <= 75; lat += 15) {
      const y = ((90 - lat) / 180) * canvas.height;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
    }
    ctx.fillStyle = NEUTRAL;
    ctx.fill(this.buildPath(this.world.neutral), 'evenodd');
  }

  paint(c: GeoCountry | string, rgb: RGB) {
    const id = typeof c === 'string' ? c : c.id;
    const css = `rgb(${rgb[0] | 0},${rgb[1] | 0},${rgb[2] | 0})`;
    if (this.last.get(id) === css) return;
    this.last.set(id, css);
    const path = this.paths.get(id)!;
    const ctx = this.ctx;
    ctx.fillStyle = css;
    ctx.fill(path, 'evenodd');
    ctx.strokeStyle = BORDER;
    ctx.lineWidth = 1.4;
    ctx.stroke(path);
    this.dirty = true;
  }

  /** Repaints every country whose colour differs from what is on the canvas. Returns #repainted. */
  refresh(colorOf: (id: string) => RGB): number {
    let n = 0;
    for (const c of this.world.countries) {
      const before = this.last.get(c.id);
      this.paint(c, colorOf(c.id));
      if (this.last.get(c.id) !== before) n++;
    }
    return n;
  }
}

export function hsl(h: number, s: number, l: number): RGB {
  s /= 100; l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}
export const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const css = (c: RGB) => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
