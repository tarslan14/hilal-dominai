// Utility-based bot leaders. Each turn every bot scores its candidate actions, adds
// personality-weighted noise and executes the best 1-3. Bots use the same doAction() as the player and
// only know what the engine exposed to them (relations, grudges, detected ops): no peeking at hidden state.
import { acceptance, doAction, type Params } from '../engine/actions';
import { battleMods } from '../engine/combat';
import { CONFIG } from '../engine/config';
import { manpowerCap } from '../engine/economy';
import { clamp, rand, shuffle } from '../engine/rng';
import { allied, computePowers, links, milOf, nations, ownership, rel, rootOf, type PowerInfo } from '../engine/state';
import { garrisonRatio, overstretchOf } from '../engine/tick';
import type { Country, GameState } from '../engine/types';

export interface Candidate {
  id: string;
  tid: string;
  p?: Params;
  u: number;
  why?: string;
}

export interface BotView {
  s: GameState;
  N: Country;
  lands: Country[];
  powers: Record<string, PowerInfo>;
  own: Map<string, Country[]>;
}

/** Cheap closed-form estimate of the attacker's win chance (the exact Monte-Carlo is reserved for the UI). */
export function quickOdds(s: GameState, N: Country, from: Country, T: Country, amount: number): number {
  const D = s.countries[T.owner];
  const m = battleMods({
    attTroops: amount, defTroops: T.troops, attTech: N.tech, defTech: D.tech, attStability: N.stability, defStability: T.stability,
    terrain: T.terrain, amphibious: !from.neighbors.includes(T.id), defHome: T.id === D.id, attDisrupted: from.disrupted > 0, defDisrupted: T.disrupted > 0, fort: T.buildings.barracks,
  });
  const edge = m.att - m.def; // die-modifier advantage
  const ratio = (amount * Math.exp(edge * 0.9)) / Math.max(0.05, T.troops);
  return clamp((ratio - 0.5) / 1.7, 0, 0.98);
}

/** How badly `N` wants a war with root nation `O` (0..~1.5). Exposed for the advisor's threat radar. */
export function warDesire(v: BotView, O: Country): { u: number; ratio: number; reasons: string[] } {
  const { s, N, powers } = v;
  const tr = N.leader.traits;
  const reasons: string[] = [];
  const myMil = powers[N.id]?.mil ?? 0.01;
  let their = powers[O.id]?.mil ?? 0.01;
  for (const a of O.allies) their += (powers[a]?.mil ?? 0) * 0.5;
  for (const p of nations(s)) if (p.overlord === O.id) their += powers[p.id]?.mil ?? 0;
  const ratio = myMil / Math.max(0.01, their);
  const grudge = N.memory.grudges[O.id] ?? 0;
  const r = rel(s, N.id, O.id);
  let desire = tr.aggression * 0.45 + tr.ambition * 0.25 + (N.leader.goal === 'conquest' ? 0.15 : 0) + grudge / 140 - r / 180;
  if (grudge > 30) reasons.push('holds a grudge');
  if (r < -40) reasons.push('relations are hostile');
  const oh = s.countries[O.id];
  if (oh.stability < 35) { desire += (40 - oh.stability) / 120; reasons.push('sees your instability as weakness'); }
  if (O.wars.length) { desire += 0.12; reasons.push('you are distracted by another war'); }
  if (s.coalition && s.coalition.target === O.id && s.coalition.members.includes(N.id)) { desire += 0.55; reasons.push('member of the coalition'); }
  if (N.government === 'democracy') desire -= 0.25;
  if (r > 0) desire -= r / 120; // friends are not prey
  const casus = r < -15 || grudge > 20 || tr.aggression > 0.78 || (s.coalition?.target === O.id && s.coalition.members.includes(N.id));
  if (!casus) desire *= 0.4;
  if (O.id === s.playerId) desire *= CONFIG.difficulty[s.difficulty].botAggro;
  if (ratio > 2) reasons.push(`outguns you ${ratio.toFixed(1)}:1`);
  let u = ratio >= CONFIG.ai.warPowerRatio ? desire * Math.min(1.5, 0.6 + ratio / 4) : desire * 0.25 * ratio;
  u -= CONFIG.ai.peaceInertia; // inertia of peace
  u -= N.wars.length * 0.45 + (N.treasury < 0 ? 0.4 : 0) + (N.stability < 35 ? 0.35 : 0) + N.infamy / 120 + N.warExhaustion / 80;
  return { u, ratio, reasons };
}

export function decide(v: BotView): Candidate[] {
  const { s, N, lands, powers } = v;
  const tr = N.leader.traits;
  const out: Candidate[] = [];
  const add = (id: string, tid: string, u: number, p?: Params, why?: string) => u > 0 && out.push({ id, tid, u, p, why });
  const me = powers[N.id];
  if (!me) return out;
  const income = Math.max(0.01, N.lastIncome);
  const spare = N.treasury - N.lastUpkeep * 2;
  const rich = N.treasury / income; // months of income in the bank
  const atWar = N.wars.length > 0;

  // ---- frontier scan
  const foreign = new Map<string, Country[]>(); // root nation id -> its territories touching mine
  let threat = 0;
  for (const t of lands) {
    for (const l of links(t)) {
      const o = s.countries[l];
      if (o.owner === N.id) continue;
      const root = rootOf(s, o.owner);
      if (root === N.id) continue;
      let arr = foreign.get(root);
      if (!arr) foreign.set(root, (arr = []));
      if (!arr.includes(o)) arr.push(o);
    }
  }
  for (const [oid] of foreign) {
    const hostility = clamp(-rel(s, N.id, oid) / 100 + (N.memory.grudges[oid] ?? 0) / 150, 0, 1.5) + (N.wars.includes(oid) ? 1 : 0);
    threat = Math.max(threat, ((powers[oid]?.mil ?? 0) / Math.max(0.01, me.mil)) * hostility);
  }

  // ---- occupied lands: annex or puppet
  for (const t of lands) {
    if (t.status !== 'occupied') continue;
    const stretch = overstretchOf(lands);
    if (stretch >= 1.5 || tr.diplomacy > tr.aggression + 0.25) add('puppet', t.id, 1.3);
    else add('annex', t.id, 1.3);
  }

  // ---- war: attacks
  if (atWar) {
    for (const w of N.wars) {
      for (const T of foreign.get(rootOf(s, w)) ?? []) {
        if (!N.wars.includes(T.owner)) continue;
        let best: Country | null = null;
        for (const l of links(T)) {
          const f = s.countries[l];
          if (f.owner === N.id && (!best || f.troops > best.troops)) best = f;
        }
        if (!best || best.troops < 0.3) continue;
        const amount = best.troops * (best.status === 'home' ? 0.7 : 0.85);
        const p = quickOdds(s, N, best, T, amount);
        const value = Math.min(0.6, T.gdp / Math.max(1, me.gdp)) + (T.id === T.owner ? 0.35 : 0.1);
        if (p < 0.52 - tr.aggression * 0.14) continue;
        add('attack', T.id, 1.1 + p * (0.5 + value) - (1 - p) * 0.6, { from: best.id, amount }, `odds ${(p * 100).toFixed(0)}%`);
      }
    }
    // peace when it makes sense for me
    for (const w of N.wars) {
      const W = s.countries[w];
      if (W.overlord || N.overlord) continue;
      if (acceptance(s, 'peace', W, N).ok) add('peace', w, 0.85 + N.warExhaustion / 200);
    }
  }

  // ---- war: declarations
  if (!N.overlord) {
    for (const [oid] of foreign) {
      const O = s.countries[oid];
      if (!O.alive || N.wars.includes(oid) || allied(s, N.id, oid) || (N.truces[oid] ?? 0) > s.turn) continue;
      if ((N.pacts[oid] ?? 0) > s.turn && tr.loyalty > 0.25) continue;
      const d = warDesire(v, O);
      add('declare_war', oid, d.u + 0.3, undefined, d.reasons.join(', '));
    }
  }

  // ---- defence & build-up
  const cap = manpowerCap(lands, N.laws.conscription);
  const room = cap - me.troops;
  if (room > cap * 0.02 && spare > 0) {
    const want = Math.min(room, (spare * 0.5) / Math.max(1e-6, N.unitCost * CONFIG.eco.recruitMonths));
    const sustainable = N.lastUpkeep + want * N.unitCost < income * (atWar ? 0.95 : 0.6);
    if (want > 0.2 && sustainable) {
      const front = lands.reduce((m, t) => (t.status !== 'occupied' && (t.troops < m.troops || m.status === 'occupied') ? t : m), lands[0]);
      const tid = s.countries[N.id].owner === N.id ? N.id : front.id;
      add('recruit', tid, (atWar ? 0.95 : 0.3) + Math.min(0.5, threat * 0.3) + tr.paranoia * 0.15 + (tr.aggression > 0.6 ? 0.1 : 0), { amount: want });
    }
  }
  if (rich > 8 && N.tech < CONFIG.eco.techMax) add('research', N.id, 0.3 + Math.min(0.3, rich / 60) + (atWar ? 0.1 : 0));
  if (rich > 5) {
    const best = lands.filter((t) => t.status !== 'occupied').sort((a, b) => b.gdp - a.gdp)[0];
    // development: greedy leaders build industry, paranoid ones barracks, shaky ones farms
    if (best) {
      const B = CONFIG.build.max;
      if (best.buildings.industry < B) add('build_industry', best.id, 0.28 + tr.greed * 0.3 + (N.leader.goal === 'wealth' ? 0.15 : 0));
      if (best.buildings.farm < B && best.stability < 55) add('build_farm', best.id, 0.3 + (55 - best.stability) / 120);
      const h = s.countries[N.id];
      if (h.owner === N.id && h.buildings.barracks < B && (threat > 0.6 || atWar)) add('build_barracks', N.id, 0.3 + tr.paranoia * 0.25 + Math.min(0.2, threat * 0.1));
    }
  }
  for (const t of lands) {
    if (t.unrest < 50) continue;
    const harsh = N.government !== 'democracy' || t.status !== 'home';
    add(harsh ? 'suppress' : 'reform', t.id, 0.45 + t.unrest / 160 + (t.status !== 'home' && garrisonRatio(t) < 0.6 ? 0.15 : 0));
  }

  // ---- laws: react to war, bankruptcy and unrest
  {
    const L = N.laws;
    const home = s.countries[N.id];
    if (atWar && !L.conscription && room < cap * 0.1) add('law', N.id, 0.6, { law: 'conscription' });
    if (!atWar && L.conscription && threat < 0.4) add('law', N.id, 0.35, { law: 'conscription' });
    if (N.treasury < 0 && L.tax < 1) add('law', N.id, 0.7, { law: 'tax_high' });
    if (rich > 14 && L.tax === 1) add('law', N.id, 0.4, { law: 'tax_normal' });
    if (home.unrest > 65 && !L.martial && N.government !== 'democracy') add('law', N.id, 0.55, { law: 'martial' });
    if (home.unrest < 30 && L.martial) add('law', N.id, 0.45, { law: 'martial' });
  }

  // ---- diplomacy
  if (!N.overlord) {
    const reach = [...foreign.keys()].map((id) => s.countries[id]).filter((o) => o.alive && !o.overlord && !N.wars.includes(o.id));
    if (N.allies.length < 2 && (threat > 0.8 || tr.diplomacy > 0.8) && rand(s) < 0.35) {
      const c = reach.filter((o) => !N.allies.includes(o.id) && rel(s, N.id, o.id) > 25).sort((a, b) => rel(s, N.id, b.id) - rel(s, N.id, a.id))[0];
      if (c && (c.id === s.playerId || acceptance(s, 'alliance', N, c).ok)) add('alliance', c.id, 0.35 + tr.paranoia * 0.25 + tr.diplomacy * 0.2 + Math.min(0.3, threat * 0.2));
    }
    if (N.trade.length < 3) {
      const c = reach.filter((o) => !N.trade.includes(o.id) && rel(s, N.id, o.id) > 0 && o.trade.length < CONFIG.eco.tradeMaxDeals).sort((a, b) => (powers[b.id]?.gdp ?? 0) - (powers[a.id]?.gdp ?? 0))[0];
      if (c) add('trade', c.id, 0.3 + tr.greed * 0.3);
    }
    const scary = reach.filter((o) => rel(s, N.id, o.id) < -15 && (powers[o.id]?.mil ?? 0) > me.mil * 1.5 && !(N.pacts[o.id] > s.turn))[0];
    if (scary && tr.paranoia > 0.45) add('pact', scary.id, 0.3 + tr.paranoia * 0.3);
    for (const o of nations(s)) {
      if (o.id === N.id) continue;
      const r = rel(s, N.id, o.id);
      if (N.sanctions.includes(o.id)) {
        if (r > -5 && !(s.coalition?.target === o.id && s.coalition.members.includes(N.id))) add('lift_sanction', o.id, 0.35);
      } else if (r < -55 && (N.memory.grudges[o.id] ?? 0) > 20 && !N.wars.includes(o.id) && o.overlord !== N.id) add('sanction', o.id, 0.3 + tr.aggression * 0.15);
    }
    // betrayal: ambitious, disloyal leaders drop weak allies they would rather eat
    for (const a of N.allies) {
      const A = s.countries[a];
      if (foreign.has(a) && tr.ambition > 0.8 && tr.loyalty < 0.2 && (powers[a]?.mil ?? 0) < me.mil * 0.4 && A.stability < 50) add('break_alliance', a, 0.35);
    }
  }

  // ---- subversion of weaker neighbours & rivals
  if (!N.overlord && rich > 4) {
    for (const [oid] of foreign) {
      const O = s.countries[oid];
      if (!O.alive || O.overlord === N.id || N.wars.includes(oid)) continue;
      const ratio = me.mil / Math.max(0.01, powers[oid]?.mil ?? 0.01);
      const inf = O.influence[N.id] ?? 0;
      const r = rel(s, N.id, oid);
      const aggroMul = oid === s.playerId ? CONFIG.difficulty[s.difficulty].botAggro : 1;
      if (oid !== s.playerId && ratio >= CONFIG.influence.vassalPowerRatio && !allied(s, N.id, oid) && tr.ambition > 0.65 && (inf >= 30 || O.wars.length > 0 || O.stability < 35) && acceptance(s, 'vassal', N, O).ok) add('vassalize', oid, 0.2 + tr.ambition * 0.4);
      if (oid !== s.playerId && !allied(s, N.id, oid) && inf >= CONFIG.influence.coupMin && tr.ambition > 0.5 && ratio > 1) add('coup', oid, 0.35 + tr.ambition * 0.3 + inf / 250);
      if (oid !== s.playerId && ratio >= 2 && (N.leader.goal === 'influence' || tr.ambition > 0.65) && inf < 70) add(tr.greed > 0.5 ? 'propaganda' : 'bribe', oid, 0.22 + tr.ambition * 0.25 + (N.leader.goal === 'influence' ? 0.2 : 0));
      if (r < -30) {
        // rivals: spy, sabotage, stir chaos. Choice of tool follows personality.
        const spy = O.spies[N.id] ?? 0;
        const base = (0.18 + -r / 220 + tr.ambition * 0.15 + (N.memory.grudges[oid] ?? 0) / 300) * aggroMul;
        const T = foreign.get(oid)![Math.floor(rand(s) * foreign.get(oid)!.length)];
        if (spy < 2 && tr.paranoia > 0.4) add('spy', oid, base + 0.1);
        else if (tr.aggression > 0.6) add(rand(s) < 0.5 ? 'sabotage' : 'cyber', T.id, base + 0.05);
        else add(rand(s) < 0.5 ? 'protests' : rand(s) < 0.5 ? 'fund_opposition' : 'misinfo', rand(s) < 0.5 ? T.id : oid, base);
      }
    }
    for (const p of nations(s)) {
      if (p.overlord === N.id && (p.influence[N.id] ?? 0) >= CONFIG.influence.absorbMin && tr.ambition > 0.55 && overstretchOf(lands) < 1) add('absorb', p.id, 0.5 + tr.ambition * 0.2);
    }
  }

  // ---- personality-weighted noise: erratic (aggressive / ambitious) leaders are less predictable
  const amp = CONFIG.ai.noise * (0.6 + 0.8 * ((tr.aggression + tr.ambition) / 2));
  for (const c of out) c.u *= 1 + (rand(s) * 2 - 1) * amp;
  out.sort((a, b) => b.u - a.u);
  const max = Math.min(CONFIG.ai.maxActions, 1 + (me.rank <= 30 ? 1 : 0) + (atWar ? 1 : 0));
  const picked: Candidate[] = [];
  for (const c of out) {
    if (c.u < 0.3 || picked.length >= max) break;
    if (picked.some((p) => p.id === c.id && (p.tid === c.tid || c.id !== 'attack'))) continue;
    if (c.id.startsWith('build_') && picked.some((p) => p.id.startsWith('build_'))) continue;
    if (c.id === 'declare_war' && c.u < CONFIG.ai.warThreshold) continue;
    picked.push(c);
  }
  return picked;
}

/** Free troop redistribution for bots: garrison restless lands, mass the rest on threatened borders. */
function rebalance(s: GameState, N: Country, lands: Country[]) {
  if (lands.length < 2) return;
  let total = 0;
  const need: number[] = [];
  const weight: number[] = [];
  for (const t of lands) {
    total += t.troops;
    need.push(t.status === 'home' ? 0 : t.population * CONFIG.stab.garrisonPerMPop * (t.unrest > 40 ? 1 : 0.5));
    let w = t.status === 'home' ? 1.2 : 0.3;
    for (const l of links(t)) {
      const o = s.countries[l];
      if (o.owner === N.id) continue;
      const hostile = N.wars.includes(o.owner) ? 4 : rel(s, N.id, o.owner) < -25 ? 1.2 : 0.2;
      w += hostile * Math.sqrt(o.troops + 1) * 0.3;
    }
    weight.push(w);
  }
  const garr = need.reduce((a, b) => a + b, 0);
  const scale = garr > total * 0.5 ? (total * 0.5) / garr : 1;
  const free = total - garr * scale;
  const wsum = weight.reduce((a, b) => a + b, 0);
  lands.forEach((t, i) => {
    const target = need[i] * scale + (free * weight[i]) / wsum;
    t.troops += (target - t.troops) * 0.5;
  });
}

export function runBots(s: GameState) {
  const powers = computePowers(s);
  const own = ownership(s);
  const bots = shuffle(s, nations(s).filter((n) => n.id !== s.playerId));
  // all bots decide on the same snapshot ("simultaneous"), then act in random order
  const plans = bots.map((N) => ({ N, acts: decide({ s, N, lands: own.get(N.id) ?? [], powers, own }) }));
  for (const { N, acts } of plans) {
    for (const a of acts) {
      if (!N.alive || s.over) break;
      doAction(s, N.id, a.id, a.tid, a.p);
    }
  }
  const own2 = ownership(s);
  for (const N of bots) if (N.alive) rebalance(s, N, own2.get(N.id) ?? []);
}

export { milOf };
