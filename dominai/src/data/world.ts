// Loads Natural Earth borders (world-atlas 50m) + bundled seed stats into a pure data structure.
// No DOM / Three imports: usable from the browser, tests and the headless simulator.
import topoJson from 'world-atlas/countries-50m.json';
import { feature, neighbors as topoNeighbors } from 'topojson-client';
import dataJson from './countries.json';

export type Ring = number[][]; // [lon, lat][]
export type Polygon = Ring[]; // outer ring + holes
export type GovCode = 'D' | 'A' | 'M' | 'O' | 'T' | 'J' | 'H' | 'F';

export interface CountrySeed {
  gdp: number;
  pop: number;
  troops: number;
  tech: number;
  stability: number;
  gov: GovCode;
  oil: number;
}

export interface GeoCountry {
  id: string;
  mapName: string;
  name: string;
  polygons: Polygon[];
  bboxes: [number, number, number, number][];
  centroid: [number, number];
  area: number; // thousand km^2 (approx)
  neighbors: string[];
  seaLinks: string[];
  terrain: number; // 0 flat, 1 mountainous / jungle
  seed: CountrySeed;
}

export interface World {
  countries: GeoCountry[];
  byId: Record<string, GeoCountry>;
  neutral: Polygon[];
}

const D2R = Math.PI / 180;

export function haversineKm(a: [number, number], b: [number, number]): number {
  const dLat = (b[1] - a[1]) * D2R;
  const dLon = (b[0] - a[0]) * D2R;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * D2R) * Math.cos(b[1] * D2R) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(s)));
}

function ringAreaCentroid(ring: Ring): { area: number; cx: number; cy: number } {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += f;
    cx += (ring[j][0] + ring[i][0]) * f;
    cy += (ring[j][1] + ring[i][1]) * f;
  }
  a /= 2;
  if (Math.abs(a) < 1e-12) return { area: 0, cx: ring[0][0], cy: ring[0][1] };
  return { area: Math.abs(a), cx: cx / (6 * a), cy: cy / (6 * a) };
}

let cached: World | null = null;

export function loadWorld(): World {
  if (cached) return cached;
  const topo = topoJson as any;
  const data = dataJson as any;
  const geoms: any[] = topo.objects.countries.geometries;
  const fc = feature(topo, topo.objects.countries) as any;
  const nb = topoNeighbors(geoms);

  const rowsByName = new Map<string, any[]>();
  for (const r of data.rows) rowsByName.set(r[0], r);
  const mountainous = new Set<string>(data.mountainous);

  const byName = new Map<string, GeoCountry>();
  const geomOwner: (string | null)[] = [];
  const neutral: Polygon[] = [];

  // Rings that cross the antimeridian jump from +180 to -180; make their longitudes continuous
  // (values may then leave [-180,180]; painter and point lookup handle the wrap).
  const unwrap = (ring: Ring): Ring => {
    let off = 0;
    return ring.map((p, i) => {
      if (i > 0) {
        const d = p[0] - ring[i - 1][0];
        if (d > 180) off -= 360;
        else if (d < -180) off += 360;
      }
      return [p[0] + off, p[1]];
    });
  };
  const polysOf = (f: any): Polygon[] => {
    const raw: Polygon[] = !f.geometry ? [] : f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    return raw.map((poly) => poly.map(unwrap));
  };

  // pass 1: sovereign countries present in the seed table
  fc.features.forEach((f: any, i: number) => {
    const mapName: string = geoms[i].properties.name;
    const row = rowsByName.get(mapName);
    if (!row || byName.has(mapName)) return;
    const id: string = geoms[i].id ? String(geoms[i].id) : 'X' + mapName.replace(/[^A-Za-z]/g, '').slice(0, 4).toUpperCase();
    byName.set(mapName, {
      id,
      mapName,
      name: data.displayNames[mapName] ?? mapName,
      polygons: polysOf(f),
      bboxes: [],
      centroid: [0, 0],
      area: 0,
      neighbors: [],
      seaLinks: [],
      terrain: mountainous.has(mapName) ? 1 : 0,
      seed: { gdp: row[1], pop: row[2], troops: Math.max(1, row[3]), tech: row[4], stability: row[5], gov: row[6], oil: row[7] },
    });
    geomOwner[i] = mapName;
  });
  // pass 2: dependencies merged into their parent, everything else is neutral land
  fc.features.forEach((f: any, i: number) => {
    if (geomOwner[i]) return;
    const mapName: string = geoms[i].properties.name;
    const parent = data.territories[mapName];
    const pc = parent ? byName.get(parent) : undefined;
    if (pc) {
      pc.polygons.push(...polysOf(f));
      geomOwner[i] = parent;
    } else {
      neutral.push(...polysOf(f));
      geomOwner[i] = null;
    }
  });

  const countries = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  const samples = new Map<string, [number, number][]>();
  for (const c of countries) {
    let best = -1;
    let total = 0;
    const pts: [number, number][] = [];
    for (const poly of c.polygons) {
      const outer = poly[0];
      let minX = 180, minY = 90, maxX = -180, maxY = -90;
      for (const p of outer) {
        if (p[0] < minX) minX = p[0];
        if (p[0] > maxX) maxX = p[0];
        if (p[1] < minY) minY = p[1];
        if (p[1] > maxY) maxY = p[1];
        pts.push([p[0], p[1]]);
      }
      c.bboxes.push([minX, minY, maxX, maxY]);
      const ac = ringAreaCentroid(outer);
      const km = ac.area * Math.cos(ac.cy * D2R) * 12.36; // deg^2 -> thousand km^2
      total += km;
      if (km > best) {
        best = km;
        c.centroid = [ac.cx, ac.cy];
      }
    }
    c.area = total;
    if (c.centroid[0] > 180) c.centroid[0] -= 360;
    if (c.centroid[0] < -180) c.centroid[0] += 360;
    const stride = Math.max(1, Math.floor(pts.length / 40));
    samples.set(c.id, pts.filter((_, k) => k % stride === 0));
  }

  const idOfName = (n: string) => byName.get(n)?.id;
  const link = (arr: string[], id: string) => {
    if (!arr.includes(id)) arr.push(id);
  };
  // land neighbours from shared topology arcs
  nb.forEach((list: number[], i: number) => {
    const a = geomOwner[i];
    if (!a) return;
    for (const j of list) {
      const b = geomOwner[j];
      if (!b || b === a) continue;
      link(byName.get(a)!.neighbors, idOfName(b)!);
      link(byName.get(b)!.neighbors, idOfName(a)!);
    }
  });
  // hand-written major sea lanes
  for (const [a, b] of data.seaLanes as [string, string][]) {
    const ca = byName.get(a);
    const cb = byName.get(b);
    if (!ca || !cb || ca.neighbors.includes(cb.id)) continue;
    link(ca.seaLinks, cb.id);
    link(cb.seaLinks, ca.id);
  }
  // automatic sea links for islands and near-isolated states
  const minDist = (a: GeoCountry, b: GeoCountry) => {
    let m = Infinity;
    for (const p of samples.get(a.id)!) for (const q of samples.get(b.id)!) {
      const d = haversineKm(p, q);
      if (d < m) m = d;
    }
    return m;
  };
  for (const c of countries) {
    if (c.neighbors.length > 1) continue;
    const want = c.neighbors.length === 0 ? 3 : 2;
    const cap = c.neighbors.length === 0 ? 6000 : 1500;
    const cand = countries
      .filter((o) => o.id !== c.id && !c.neighbors.includes(o.id) && haversineKm(c.centroid, o.centroid) < 9000)
      .map((o) => ({ o, d: minDist(c, o) }))
      .sort((x, y) => x.d - y.d);
    for (const { o, d } of cand) {
      if (c.seaLinks.length >= want) break;
      if (d > cap && c.seaLinks.length > 0) break;
      link(c.seaLinks, o.id);
      link(o.seaLinks, c.id);
    }
  }

  const byId: Record<string, GeoCountry> = {};
  for (const c of countries) byId[c.id] = c;
  cached = { countries, byId, neutral };
  return cached;
}

/** Point-in-polygon lookup (lon/lat degrees) -> country id or null. */
export function countryAt(world: World, lon: number, lat: number): string | null {
  for (const c of world.countries) {
    for (let k = 0; k < c.polygons.length; k++) {
      const bb = c.bboxes[k];
      if (lat < bb[1] || lat > bb[3]) continue;
      const x = lon < bb[0] ? lon + 360 : lon > bb[2] ? lon - 360 : lon;
      if (x < bb[0] || x > bb[2]) continue;
      const poly = c.polygons[k];
      if (!inRing(poly[0], x, lat)) continue;
      let hole = false;
      for (let h = 1; h < poly.length; h++) if (inRing(poly[h], x, lat)) hole = true;
      if (!hole) return c.id;
    }
  }
  return null;
}

function inRing(ring: Ring, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
