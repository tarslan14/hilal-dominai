// Per-turn world simulation: chaos transmission, unrest/stability, rebellions, coups, diplomacy drift, coalitions.
import { CONFIG } from './config';
import { endWar, isPlayer, killNation, restoreNation } from './nation';
import { chance, clamp, pick, rand, randRange } from './rng';
import { addNews, addRel, allied, computePowers, links, makeLeader, nations, ownership, rel, relKey, rootOf, type PowerInfo } from './state';
import type { Country, GameState, Gov } from './types';

/** Imperial overstretch points of a nation: un-integrated foreign lands beyond the free allowance. */
export function overstretchOf(lands: Country[]): number {
  let pts = 0;
  for (const t of lands) if (t.status !== 'home') pts += t.status === 'occupied' ? 1 : 1 - t.integration / 100;
  return Math.max(0, pts - CONFIG.overstretch.freeTerritories);
}

export function garrisonRatio(t: Country): number {
  return clamp(t.troops / Math.max(0.3, t.population * CONFIG.stab.garrisonPerMPop), 0, 1);
}

/**
 * Plague-style unrest transmission. Every "infectious" territory (unrest > threshold) may pass unrest along
 * three vectors: land borders, trade links of its owner, and media links (sea lanes; boosted by misinformation).
 * p = beta * intensity * vectorWeight * (1 - targetStability/130); unrest only flows downhill.
 */
export function spreadChaos(s: GameState) {
  const K = CONFIG.chaos;
  const delta: Record<string, number> = {};
  for (const id of s.ids) {
    const src = s.countries[id];
    if (src.unrest <= K.threshold) continue;
    const intensity = (src.unrest - K.threshold) / (100 - K.threshold);
    const boost = src.mediaInfected > 0 ? K.mediaBoost : 1;
    const vectors: [string, number][] = [];
    for (const n of src.neighbors) vectors.push([n, K.borderWeight]);
    for (const n of src.seaLinks) vectors.push([n, K.mediaWeight * boost]);
    for (const n of s.countries[src.owner].trade) vectors.push([n, K.tradeWeight]);
    for (const [tid, w] of vectors) {
      const dst = s.countries[tid];
      if (dst.unrest >= src.unrest) continue;
      const p = K.beta * intensity * w * (dst.mediaInfected > 0 ? K.mediaBoost : 1) * (1 - dst.stability / 130) * (s.countries[dst.owner].laws.censorship ? CONFIG.laws.censorChaos : 1);
      if (chance(s, p)) delta[tid] = (delta[tid] ?? 0) + randRange(s, K.doseMin, K.doseMax) * Math.min(1, w + 0.3);
    }
  }
  for (const tid in delta) {
    const t = s.countries[tid];
    t.unrest = clamp(t.unrest + Math.min(14, delta[tid]), 0, 100);
    if (delta[tid] > 9 && (t.owner === s.playerId || t.unrest > 60)) addNews(s, 'chaos', `Unrest spills over into ${t.name}.`, t.owner === s.playerId ? 2 : 1, [tid]);
  }
}

export function coupIn(s: GameState, id: string, cause: string) {
  const N = s.countries[id];
  if (isPlayer(s, id)) {
    if (!s.over) s.over = { won: false, reason: `Your government was overthrown: ${cause}.`, turn: s.turn };
    return;
  }
  const govs: Gov[] = ['junta', 'democracy', 'autocracy', 'hybrid'];
  const old = N.leader.name;
  if (chance(s, 0.6)) N.government = pick(s, govs);
  N.leader = makeLeader(s, N.government);
  N.baseStab = clamp(42 + rand(s) * 22, 0, 100);
  N.baseUnrest = clamp((75 - N.baseStab) * 0.7, 0, 90);
  N.stability = 40;
  N.unrest = clamp(N.unrest - 25, 0, 100);
  N.brokeTurns = 0;
  N.treasury = Math.max(N.treasury, 0);
  for (const k in N.influence) N.influence[k] *= 0.4;
  N.memory = { grudges: {}, betrayedBy: [], promises: {} };
  if (N.overlord) {
    addNews(s, 'diplo', `The new regime in ${N.name} throws off the yoke of ${s.countries[N.overlord].name}.`, 3, [id, N.overlord]);
    N.overlord = null;
  }
  for (const w of N.wars.slice()) if (chance(s, 0.5)) endWar(s, id, w);
  addNews(s, 'event', `Coup in ${N.name}: ${old} is overthrown (${cause}). ${N.leader.title} ${N.leader.name} takes power.`, 2, [id]);
  s.fx.push({ kind: 'pulse', to: id, color: '#ffb84d' });
}

export function stabilityTick(s: GameState) {
  const S = CONFIG.stab;
  const O = CONFIG.overstretch;
  const own = ownership(s);
  const stretch: Record<string, number> = {};
  for (const [id, lands] of own) stretch[id] = overstretchOf(lands);

  for (const id of s.ids) {
    const t = s.countries[id];
    const N = s.countries[t.owner];
    const gr = garrisonRatio(t);
    const os = stretch[t.owner] ?? 0;
    // unrest drifts back to its baseline, pushed up by occupation, overstretch and war weariness
    let du = -(t.unrest - t.baseUnrest) * 0.06 - (t.unrest > t.baseUnrest ? S.unrestDecay * (0.4 + t.stability / 100) : 0);
    if (t.status === 'occupied') du += S.occupationUnrest * (1 - gr * 0.85);
    else if (t.status === 'annexed') du += S.annexedUnrest * (1 - t.integration / 100) * (1 - gr * 0.7);
    if (t.status !== 'home') du += os * O.unrestPerPoint * 4;
    du += N.warExhaustion * 0.03;
    if (N.laws.martial && t.unrest > 0) du -= CONFIG.laws.martialUnrest;
    t.unrest = clamp(t.unrest + du, 0, 100);

    let target = t.baseStab - S.unrestWeight * Math.max(0, t.unrest - t.baseUnrest) - S.warExhaustionWeight * N.warExhaustion;
    const L = CONFIG.laws;
    target += t.buildings.farm * CONFIG.build.farmStab + L.taxStab[N.laws.tax + 1] + (N.laws.conscription ? L.conscriptStab : 0) + (N.laws.martial ? L.martialStab : 0) + (N.laws.censorship ? L.censorStab : 0);
    if (N.treasury < 0) target -= S.brokeMalus * Math.min(1, N.brokeTurns / 2 + 0.3);
    if (t.status === 'home') target -= Math.min(O.maxMalus, os * O.perTerritory);
    else target -= 8 * (1 - t.integration / 100);
    t.stability = clamp(t.stability + (target - t.stability) * S.drift, 0, 100);
    if (t.mediaInfected > 0) t.mediaInfected--;
    if (t.disrupted > 0) t.disrupted--;
  }

  // rebellions in held lands
  for (const id of s.ids) {
    const t = s.countries[id];
    if (t.status === 'home' || t.unrest < S.rebellionThreshold) continue;
    const gr = garrisonRatio(t);
    if (!chance(s, S.rebellionChance * (1.15 - gr))) continue;
    const former = s.countries[t.owner];
    addNews(s, 'chaos', `${t.name} rises up and throws out the ${former.name} occupation!`, t.owner === s.playerId ? 3 : 2, [id, former.id]);
    // garrison is expelled to the owner's home
    s.countries[former.id].troops += t.troops * 0.6;
    restoreNation(s, id, null);
    t.troops = Math.max(1, t.population * 0.8);
    t.unrest = 35;
    t.stability = 45;
    former.truces[id] = s.turn + 6;
    t.truces[former.id] = s.turn + 6;
    s.relations[relKey(id, former.id)] = -60;
    s.fx.push({ kind: 'conquer', to: id });
  }

  // coups / bankruptcy
  for (const N of nations(s)) {
    if (isPlayer(s, N.id)) {
      if (N.stability <= S.playerCoupStability) coupIn(s, N.id, 'the streets turned against you');
      else if (N.brokeTurns >= CONFIG.eco.bankruptcyTurns) coupIn(s, N.id, 'the bankrupt state could no longer pay its army');
      else if (N.stability < 20) addNews(s, 'chaos', `Your stability is critical (${N.stability.toFixed(0)}). A coup is brewing.`, 3, [N.id]);
      continue;
    }
    if (N.brokeTurns >= CONFIG.eco.bankruptcyTurns + 2) coupIn(s, N.id, 'state bankruptcy');
    else if (N.stability < S.coupThreshold && chance(s, S.coupChance * (1 - N.stability / 30))) coupIn(s, N.id, 'collapse of public order');
  }
}

export function diplomacyTick(s: GameState, powers: Record<string, PowerInfo> = computePowers(s)) {
  const Dp = CONFIG.diplomacy;
  const alive = nations(s);
  // relations drift toward a baseline shaped by treaties, sanctions and grudges
  for (const k in s.relations) {
    const [a, b] = k.split('|');
    const A = s.countries[a], B = s.countries[b];
    if (!A.alive || !B.alive) continue;
    if (A.wars.includes(b)) continue;
    let base = 0;
    if (A.allies.includes(b)) base += 45;
    if (A.trade.includes(b)) base += 15;
    if (A.overlord === b || B.overlord === a) base += 35;
    if (A.sanctions.includes(b) || B.sanctions.includes(a)) base -= 35;
    base -= ((A.memory.grudges[b] ?? 0) + (B.memory.grudges[a] ?? 0)) * 0.35;
    s.relations[k] = clamp(s.relations[k] + (base - s.relations[k]) * Dp.relDriftToBase, -100, 100);
  }
  for (const N of alive) {
    // infamy poisons relations with everybody who is not bound to you
    if (N.infamy > 8) {
      for (const o of alive) if (o.id !== N.id && !allied(s, o.id, N.id)) addRel(s, N.id, o.id, -N.infamy * 0.025);
    }
    N.infamy = Math.max(0, N.infamy - CONFIG.overstretch.infamyDecay);
    for (const g in N.memory.grudges) {
      N.memory.grudges[g] -= 0.8;
      if (N.memory.grudges[g] <= 0) delete N.memory.grudges[g];
    }
    for (const k in N.influence) {
      if (N.overlord === k) N.influence[k] = Math.min(100, N.influence[k] + 2);
      else if (N.debt?.to === k) N.influence[k] = Math.min(100, N.influence[k] + 1);
      else {
        N.influence[k] -= CONFIG.influence.decay;
        if (N.influence[k] <= 0) delete N.influence[k];
      }
    }
    for (const p in N.pacts) if (N.pacts[p] <= s.turn) delete N.pacts[p];
    for (const p in N.truces) if (N.truces[p] <= s.turn) delete N.truces[p];
    N.warExhaustion = clamp(N.warExhaustion + (N.wars.length ? 1.6 : -3), 0, 100);
    // debt repayment: paid off slowly when the debtor is flush
    if (N.debt && N.treasury > N.debt.amount * 2.5) {
      N.treasury -= N.debt.amount;
      s.countries[N.debt.to].treasury += N.debt.amount;
      N.debt = null;
    }
    // restless puppets
    if (N.overlord && !isPlayer(s, N.id)) {
      const O = s.countries[N.overlord];
      const weak = O.stability < 30 || (powers[O.id]?.mil ?? 1) < (powers[N.id]?.mil ?? 0) * 1.2;
      if (weak && (N.influence[O.id] ?? 0) < 85 && chance(s, 0.08 * (1.2 - N.leader.traits.loyalty))) {
        addNews(s, 'diplo', `${N.name} breaks away from its weakened overlord ${O.name}.`, O.id === s.playerId ? 3 : 2, [N.id, O.id]);
        N.overlord = null;
        addRel(s, N.id, O.id, -30);
      }
    }
  }
  // rising powers make everyone nervous
  for (const N of alive) {
    const sh = powers[N.id]?.share ?? 0;
    if (N.overlord || sh < 0.12) continue;
    for (const o of alive) {
      if (o.id === N.id || allied(s, o.id, N.id)) continue;
      addRel(s, N.id, o.id, -(sh - 0.1) * 6 * (0.5 + o.leader.traits.paranoia));
    }
  }
  coalitionTick(s, powers);
}

function coalitionTick(s: GameState, powers: Record<string, PowerInfo>) {
  const K = CONFIG.coalition;
  const thrOf = (id: string) => (id === s.playerId ? CONFIG.difficulty[s.difficulty].coalitionShare : CONFIG.difficulty.normal.coalitionShare);
  if (s.coalition) {
    const T = s.countries[s.coalition.target];
    s.coalition.members = s.coalition.members.filter((m) => s.countries[m].alive && !s.countries[m].overlord && !allied(s, m, T.id));
    const sh = powers[T.id]?.share ?? 0;
    if (!T.alive || s.coalition.members.length < 2 || (sh < thrOf(T.id) * K.dissolveShare && T.infamy < K.minInfamy * 0.5)) {
      addNews(s, 'diplo', `The coalition against ${T.name} dissolves.`, 2, [T.id]);
      for (const m of s.coalition.members) {
        const M = s.countries[m];
        const i = M.sanctions.indexOf(T.id);
        if (i >= 0) M.sanctions.splice(i, 1);
      }
      s.coalition = null;
    }
    return;
  }
  let best: Country | null = null;
  let bestScore = 0;
  for (const N of nations(s)) {
    if (N.overlord) continue;
    const sh = powers[N.id]?.share ?? 0;
    const hit = sh >= thrOf(N.id) || (N.infamy >= K.minInfamy && sh >= 0.04);
    if (!hit) continue;
    const score = sh + N.infamy / 150;
    if (score > bestScore) { best = N; bestScore = score; }
  }
  if (!best) return;
  const T = best;
  const reach = new Set<string>();
  for (const id of s.ids) if (s.countries[id].owner === T.id) for (const l of links(s.countries[id])) reach.add(rootOf(s, s.countries[l].owner));
  const members = nations(s)
    .filter((n) => n.id !== T.id && !n.overlord && !allied(s, n.id, T.id) && rel(s, n.id, T.id) < 25 && (reach.has(n.id) || (powers[n.id]?.rank ?? 99) <= 15))
    .filter((n) => n.id === s.playerId ? false : rand(s) < 0.35 + n.leader.traits.paranoia * 0.4 + T.infamy / 200)
    .sort((a, b) => (powers[b.id]?.power ?? 0) - (powers[a.id]?.power ?? 0))
    .slice(0, 12);
  if (members.length < K.minMembers) return;
  s.coalition = { target: T.id, members: members.map((m) => m.id), since: s.turn };
  for (const m of members) {
    for (const o of members) if (o.id < m.id) addRel(s, m.id, o.id, K.relBoost);
    addRel(s, m.id, T.id, -30);
    if (!m.sanctions.includes(T.id)) m.sanctions.push(T.id);
    const i = m.trade.indexOf(T.id);
    if (i >= 0) { m.trade.splice(i, 1); T.trade.splice(T.trade.indexOf(m.id), 1); }
  }
  const names = members.slice(0, 4).map((m) => m.name).join(', ');
  addNews(s, 'diplo', `A coalition forms against ${T.name}: ${names}${members.length > 4 ? ` and ${members.length - 4} others` : ''} impose sanctions and prepare for war.`, 3, [T.id, ...members.map((m) => m.id)]);
  s.fx.push({ kind: 'pulse', to: T.id, color: '#ffb84d' });
}

export { killNation };
