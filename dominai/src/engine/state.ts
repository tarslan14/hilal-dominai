import { CONFIG, type Difficulty } from './config';
import { clamp, hashSeed, pick, rand, randRange, type RngHolder } from './rng';
import type { Country, GameState, Goal, Gov, Leader, NewsItem, NewsKind, Traits } from './types';

export interface SeedInput {
  id: string;
  name: string;
  neighbors: string[];
  seaLinks: string[];
  terrain: number;
  lon: number;
  lat: number;
  area: number;
  gdp: number;
  pop: number;
  troops: number;
  tech: number;
  stability: number;
  gov: string;
  oil: number;
}

const GOV: Record<string, Gov> = { D: 'democracy', A: 'autocracy', M: 'monarchy', O: 'oneparty', T: 'theocracy', J: 'junta', H: 'hybrid', F: 'failed' };
export const GOV_LABEL: Record<Gov, string> = {
  democracy: 'Democracy', autocracy: 'Autocracy', monarchy: 'Monarchy', oneparty: 'One-party state',
  theocracy: 'Theocracy', junta: 'Military junta', hybrid: 'Hybrid regime', failed: 'Failed state',
};
const TITLES: Record<Gov, string[]> = {
  democracy: ['President', 'Prime Minister', 'Chancellor'], autocracy: ['President', 'Supreme Leader'], monarchy: ['King', 'Queen', 'Emir', 'Sultan'],
  oneparty: ['General Secretary', 'Chairman'], theocracy: ['Grand Ayatollah', 'Supreme Guide'], junta: ['General', 'Colonel', 'Marshal'],
  hybrid: ['President', 'Prime Minister'], failed: ['Warlord', 'Interim President'],
};
const SYL_A = ['Ka', 'Mo', 'Ra', 'Vi', 'An', 'El', 'Jo', 'Ta', 'Ni', 'Sa', 'Lu', 'Ha', 'Be', 'Di', 'Yu', 'Ol', 'Ar', 'Fe', 'Zo', 'Mi', 'Ste', 'Ib', 'Om', 'Che', 'Gri'];
const SYL_B = ['ren', 'lik', 'dor', 'mar', 'sha', 'vin', 'tor', 'bek', 'lan', 'ric', 'nu', 'zar', 'mir', 'das', 'len', 'go', 'ra', 'ko', 'san', 'tem'];
const SUR_A = ['Vor', 'Kal', 'Hart', 'Oko', 'Mend', 'Stra', 'Tan', 'Bel', 'Nak', 'Rost', 'Al-Ha', 'Dra', 'Fon', 'Gar', 'Yil', 'Sor', 'Mba', 'Lind', 'Cas', 'Pet', 'Zha', 'Kov', 'Abd', 'Mor', 'Ish'];
const SUR_B = ['onov', 'well', 'ström', 'ez', 'ashi', 'ini', 'berg', 'ara', 'sen', 'ovic', 'mani', 'ouri', 'eau', 'ang', 'maz', 'enko', 'by', 'ton', 'ides', 'ula', 'ian', 'ev', 'ski', 'ano'];
const GOALS: Goal[] = ['conquest', 'wealth', 'security', 'influence', 'survival'];

export function makeLeader(r: RngHolder, gov: Gov): Leader {
  const t = (base: number) => clamp(base + randRange(r, -0.3, 0.3), 0.02, 0.98);
  const bias: Partial<Record<Gov, Partial<Traits>>> = {
    democracy: { diplomacy: 0.65, aggression: 0.3, loyalty: 0.65 },
    junta: { aggression: 0.7, paranoia: 0.65, diplomacy: 0.3 },
    autocracy: { aggression: 0.55, ambition: 0.65, paranoia: 0.6 },
    theocracy: { aggression: 0.55, loyalty: 0.6 },
    oneparty: { ambition: 0.6, paranoia: 0.6 },
    failed: { paranoia: 0.75, greed: 0.7, loyalty: 0.3 },
    monarchy: { greed: 0.6, loyalty: 0.6 },
  };
  const b = bias[gov] ?? {};
  const traits: Traits = {
    aggression: t(b.aggression ?? 0.45), paranoia: t(b.paranoia ?? 0.45), ambition: t(b.ambition ?? 0.5),
    diplomacy: t(b.diplomacy ?? 0.5), greed: t(b.greed ?? 0.5), loyalty: t(b.loyalty ?? 0.5),
  };
  let goal: Goal = pick(r, GOALS);
  if (traits.aggression > 0.7 && traits.ambition > 0.5) goal = 'conquest';
  else if (traits.greed > 0.75) goal = 'wealth';
  else if (traits.paranoia > 0.8) goal = 'security';
  return {
    name: `${pick(r, SYL_A)}${pick(r, SYL_B)} ${pick(r, SUR_A)}${pick(r, SUR_B)}`,
    title: pick(r, TITLES[gov]),
    seed: Math.floor(rand(r) * 1e9),
    traits,
    goal,
  };
}

// Flavour: well-known rivalries / friendships (by display name). Purely a starting bias.
const RIVALS: [string, string, number][] = [
  ['India', 'Pakistan', -60], ['North Korea', 'South Korea', -70], ['Israel', 'Iran', -70], ['Russia', 'Ukraine', -85],
  ['Armenia', 'Azerbaijan', -60], ['Greece', 'Turkey', -30], ['China', 'Taiwan', -60], ['United States', 'Russia', -45],
  ['United States', 'China', -35], ['Saudi Arabia', 'Iran', -45], ['Serbia', 'Kosovo', -60], ['Ethiopia', 'Eritrea', -40],
  ['Morocco', 'Algeria', -40], ['Venezuela', 'Guyana', -35], ['United States', 'Iran', -55], ['United States', 'North Korea', -60],
  ['Japan', 'North Korea', -50], ['India', 'China', -30], ['Israel', 'Syria', -50], ['Sudan', 'South Sudan', -40],
];
const FRIENDS: [string, string, number][] = [
  ['United States', 'United Kingdom', 75], ['United States', 'Canada', 75], ['United States', 'Japan', 65], ['United States', 'South Korea', 65],
  ['United States', 'Australia', 70], ['France', 'Germany', 70], ['Russia', 'Belarus', 75], ['China', 'Pakistan', 60],
  ['China', 'North Korea', 55], ['Russia', 'China', 40], ['United Kingdom', 'Australia', 65], ['Australia', 'New Zealand', 80],
  ['Germany', 'Netherlands', 60], ['Spain', 'Portugal', 60], ['Saudi Arabia', 'United Arab Emirates', 60], ['United States', 'Israel', 65],
  ['Germany', 'Poland', 50], ['France', 'Italy', 50], ['Sweden', 'Finland', 70], ['Norway', 'Sweden', 65], ['United States', 'Germany', 55],
  ['United States', 'France', 55], ['Iran', 'Syria', 50], ['Brazil', 'Argentina', 40], ['Turkey', 'Azerbaijan', 65],
];

export const relKey = (a: string, b: string) => (a < b ? a + '|' + b : b + '|' + a);
export const rel = (s: GameState, a: string, b: string) => (a === b ? 100 : s.relations[relKey(a, b)] ?? 0);
export function addRel(s: GameState, a: string, b: string, d: number) {
  if (a === b) return;
  const k = relKey(a, b);
  s.relations[k] = clamp((s.relations[k] ?? 0) + d, -100, 100);
}

export function createGame(seeds: SeedInput[], opts: { seed: string; playerId: string | null; difficulty: Difficulty }): GameState {
  const s: GameState = {
    version: 2, seed: opts.seed, rng: hashSeed(opts.seed), turn: 0, playerId: opts.playerId, difficulty: opts.difficulty,
    countries: {}, ids: seeds.map((x) => x.id), relations: {}, ap: 0, news: [], choices: [], choiceSeq: 1, history: [],
    startOwners: {}, coalition: null, over: null,
    stats: { battlesWon: 0, battlesLost: 0, ops: 0, opsDetected: 0, annexed: 0, puppets: 0, warsDeclared: 0 },
    fx: [], pendingChanges: [],
  };
  const E = CONFIG.eco;
  for (const d of seeds) {
    const gov = GOV[d.gov] ?? 'hybrid';
    const income0 = d.gdp * E.taxRate;
    const food = clamp(Math.round((Math.sqrt(d.area) / Math.max(1, Math.sqrt(d.pop))) * 1.6 + rand(s) * 3), 0, 10);
    s.countries[d.id] = {
      id: d.id, name: d.name, neighbors: d.neighbors.slice(), seaLinks: d.seaLinks.slice(), terrain: d.terrain, lon: d.lon, lat: d.lat,
      gdp: d.gdp, population: d.pop, troops: d.troops, stability: d.stability, unrest: clamp(Math.round((75 - d.stability) * 0.7), 0, 90),
      baseStab: d.stability, baseUnrest: clamp(Math.round((75 - d.stability) * 0.7), 0, 90),
      resources: { oil: d.oil, food, industry: clamp(Math.round(d.tech * 0.8 + Math.log10(d.gdp + 1)), 0, 10) },
      buildings: { farm: clamp(Math.round(food / 3), 0, 3), barracks: clamp(Math.round(Math.log10(d.troops + 1) - 0.8), 0, 3), industry: clamp(Math.round(d.tech / 3.4), 0, 3) },
      owner: d.id, status: 'home', integration: 100, mediaInfected: 0, disrupted: 0,
      alive: true, treasury: income0 * E.startTreasuryMonths, tech: d.tech, government: gov, leader: makeLeader(s, gov), laws: { tax: 0, conscription: false, martial: false, censorship: gov === 'oneparty' || gov === 'theocracy' }, overlord: null,
      allies: [], wars: [], sanctions: [], trade: [], pacts: {}, truces: {}, influence: {}, spies: {}, debt: null,
      memory: { grudges: {}, betrayedBy: [], promises: {} }, infamy: 0,
      unitCost: Math.max(E.unitCostMin, (income0 * E.startUpkeepShare) / d.troops), warExhaustion: 0, brokeTurns: 0,
      lastIncome: income0, lastUpkeep: income0 * E.startUpkeepShare, hue: 0,
    };
    s.startOwners[d.id] = d.id;
  }
  // distinct-ish colours: golden-angle hues in a stable order
  s.ids.forEach((id, i) => (s.countries[id].hue = (i * 137.508) % 360));

  // starting relations: government affinity + neighbourly friction + seeded noise + flavour
  const blocOf = (g: Gov) => (g === 'democracy' ? 0 : g === 'failed' ? 2 : 1);
  for (let i = 0; i < s.ids.length; i++) {
    const a = s.countries[s.ids[i]];
    for (const bid of [...a.neighbors, ...a.seaLinks]) {
      if (bid <= a.id) continue;
      const b = s.countries[bid];
      let v = randRange(s, -22, 22);
      v += a.government === b.government ? 12 : blocOf(a.government) !== blocOf(b.government) ? -8 : 0;
      s.relations[relKey(a.id, bid)] = Math.round(v);
    }
  }
  const byName = new Map(seeds.map((x) => [x.name, x.id]));
  for (const [a, b, v] of [...RIVALS, ...FRIENDS]) {
    const ia = byName.get(a), ib = byName.get(b);
    if (!ia || !ib) continue;
    s.relations[relKey(ia, ib)] = v;
    if (v >= 60) {
      s.countries[ia].allies.push(ib);
      s.countries[ib].allies.push(ia);
    }
    if (v >= 40) {
      s.countries[ia].trade.push(ib);
      s.countries[ib].trade.push(ia);
    }
  }
  // a few starting trade links between friendly neighbours
  for (const id of s.ids) {
    const c = s.countries[id];
    for (const n of c.neighbors) if (n > id && rel(s, id, n) > 8 && c.trade.length < 3 && s.countries[n].trade.length < 3) {
      c.trade.push(n);
      s.countries[n].trade.push(id);
    }
  }
  s.ap = apMax(s);
  return s;
}

// ---------- queries ----------
export const C = (s: GameState, id: string): Country => s.countries[id];
export const nations = (s: GameState): Country[] => s.ids.map((id) => s.countries[id]).filter((c) => c.alive);
export const links = (c: Country): string[] => (c.seaLinks.length ? [...c.neighbors, ...c.seaLinks] : c.neighbors);

export function ownership(s: GameState): Map<string, Country[]> {
  const m = new Map<string, Country[]>();
  for (const id of s.ids) {
    const c = s.countries[id];
    let arr = m.get(c.owner);
    if (!arr) m.set(c.owner, (arr = []));
    arr.push(c);
  }
  return m;
}
export const territoriesOf = (s: GameState, id: string): Country[] => s.ids.map((i) => s.countries[i]).filter((c) => c.owner === id);
export const puppetsOf = (s: GameState, id: string): Country[] => nations(s).filter((c) => c.overlord === id);
export const rootOf = (s: GameState, id: string): string => s.countries[id].overlord ?? id;
export const atWar = (s: GameState, a: string, b: string) => s.countries[a].wars.includes(b);
export const allied = (s: GameState, a: string, b: string) => s.countries[a].allies.includes(b) || s.countries[a].overlord === b || s.countries[b].overlord === a;

export const milOf = (troops: number, tech: number) => troops * Math.pow(Math.max(0.5, tech) / CONFIG.mil.techRef, CONFIG.mil.techExp);

export interface PowerInfo {
  id: string;
  gdp: number;
  troops: number;
  mil: number;
  territories: number;
  power: number; // documented power formula (own lands only)
  share: number; // bloc share of world GDP+military (incl. puppets) -> victory metric
  rank: number;
}

/** Computes power + empire share for every living nation. */
export function computePowers(s: GameState): Record<string, PowerInfo> {
  const out: Record<string, PowerInfo> = {};
  let worldGdp = 0;
  let worldMil = 0;
  for (const id of s.ids) {
    const c = s.countries[id];
    const n = s.countries[c.owner];
    let p = out[c.owner];
    if (!p) p = out[c.owner] = { id: c.owner, gdp: 0, troops: 0, mil: 0, territories: 0, power: 0, share: 0, rank: 0 };
    const eff = c.status === 'occupied' ? 0.5 : 1;
    p.gdp += c.gdp * eff;
    p.troops += c.troops;
    p.mil += milOf(c.troops, n.tech);
    p.territories++;
    worldGdp += c.gdp * eff;
    worldMil += milOf(c.troops, n.tech);
  }
  let maxGdp = 1e-9, maxMil = 1e-9;
  for (const p of Object.values(out)) {
    if (p.gdp > maxGdp) maxGdp = p.gdp;
    if (p.mil > maxMil) maxMil = p.mil;
  }
  const W = CONFIG.power;
  for (const p of Object.values(out)) {
    p.power = (W.wGdp * (p.gdp / maxGdp) + W.wMil * (p.mil / maxMil)) * (1 - W.wStab + (W.wStab * s.countries[p.id].stability) / 100);
  }
  for (const p of Object.values(out)) {
    const root = rootOf(s, p.id);
    const sh = (p.gdp / worldGdp + p.mil / worldMil) / 2;
    out[root].share += sh;
  }
  for (const p of Object.values(out)) if (s.countries[p.id].overlord) p.share = (p.gdp / worldGdp + p.mil / worldMil) / 2;
  Object.values(out).sort((a, b) => b.power - a.power).forEach((p, i) => (p.rank = i + 1));
  return out;
}

export function apMax(s: GameState): number {
  if (!s.playerId) return 0;
  const A = CONFIG.ap;
  const terr = territoriesOf(s, s.playerId).length;
  const pup = puppetsOf(s, s.playerId).length;
  return Math.min(A.max, A.base + Math.floor(Math.sqrt(Math.max(0, terr - 1)) * A.perSqrtTerritory) + Math.floor(pup / A.perPuppets) + CONFIG.difficulty[s.difficulty].apBonus);
}

export function addNews(s: GameState, kind: NewsKind, text: string, importance: 1 | 2 | 3, ids: string[] = []) {
  const item: NewsItem = { turn: s.turn, kind, text, importance, ids };
  s.news.push(item); // trimmed at the end of each turn (see turn.ts)
}

export function addGrudge(s: GameState, holder: string, against: string, amount: number) {
  const m = s.countries[holder].memory;
  m.grudges[against] = clamp((m.grudges[against] ?? 0) + amount, 0, 100);
}

export function setOwner(s: GameState, territory: string, owner: string, status: Country['status']) {
  const t = s.countries[territory];
  if (t.owner !== owner) s.pendingChanges.push([territory, owner]);
  t.owner = owner;
  t.status = status;
}

export const dateOf = (turn: number) => {
  const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${m[turn % 12]} ${2026 + Math.floor(turn / 12)}`;
};

export const fmtMoney = (v: number) => {
  const a = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (a >= 1000) return `${sign}$${(a / 1000).toFixed(a >= 10000 ? 1 : 2)}T`;
  if (a >= 10) return `${sign}$${a.toFixed(0)}B`;
  if (a >= 1) return `${sign}$${a.toFixed(1)}B`;
  return `${sign}$${(a * 1000).toFixed(0)}M`;
};
export const fmtTroops = (k: number) => (k >= 1000 ? `${(k / 1000).toFixed(2)}M` : k >= 10 ? `${k.toFixed(0)}k` : `${k.toFixed(1)}k`);
