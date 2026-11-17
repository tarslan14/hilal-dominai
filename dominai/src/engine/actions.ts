// Every action a nation (player or bot) can take. Bots and the player share exactly the same rules.
import { battleOdds, resolveBattle, type BattleInput } from './combat';
import { CONFIG } from './config';
import { budgetOf, manpowerCap } from './economy';
import { conquer, declareWar, endWar, isPlayer, killNation, makePuppet, restoreNation, setWar } from './nation';
import { chance, clamp, randRange } from './rng';
import { addGrudge, addNews, addRel, allied, fmtMoney, fmtTroops, links, makeLeader, milOf, nations, rel, rootOf, setOwner, territoriesOf } from './state';
import type { ActionResult, BuildingId, Country, GameState, Laws } from './types';

export type Cat = 'political' | 'covert' | 'chaos' | 'military' | 'domestic' | 'develop';
export interface Params {
  amount?: number;
  from?: string;
  law?: string;
}
export interface Ctx {
  s: GameState;
  a: Country; // acting nation
  T: Country; // target territory
  N: Country; // nation that owns the target territory
  p: Params;
}
interface Impl {
  id: string;
  cat: Cat;
  name: string;
  desc: string;
  ap: number;
  scope: 'foreign' | 'own';
  cost?: (x: Ctx) => number;
  why?: (x: Ctx) => string | null;
  chance?: (x: Ctx) => number;
  risk?: (x: Ctx) => number;
  run: (x: Ctx) => ActionResult;
}
export interface ActionView {
  id: string;
  cat: Cat;
  name: string;
  desc: string;
  ap: number;
  cost: number;
  chance: number | null;
  risk: number | null;
  reason: string | null; // why it is unavailable (null = available)
}

// ---------- development catalogue ----------
const pc = (v: number) => Math.round(v * 100) + '%';
export const BUILDINGS: { id: BuildingId; name: string; branch: string; effect: string }[] = [
  { id: 'farm', name: 'Farms', branch: 'Agriculture', effect: `Per level: food +${CONFIG.build.farmFood}, stability +${CONFIG.build.farmStab}, manpower +${pc(CONFIG.build.farmManpower)}.` },
  { id: 'barracks', name: 'Barracks', branch: 'Military', effect: `Per level: recruiting ${pc(CONFIG.build.barracksRecruit)} cheaper here, +${CONFIG.build.barracksDef} on defence dice.` },
  { id: 'industry', name: 'Industry', branch: 'Economy', effect: `Per level: income +${pc(CONFIG.build.industryIncome)}, GDP +${pc(CONFIG.build.industryGdp)} now and faster growth.` },
];
export const buildCost = (T: Country, b: BuildingId) => T.gdp * CONFIG.build.costShare * (T.buildings[b] + 1);

export interface LawDef { id: string; group: string; name: string; effect: string; tax?: -1 | 0 | 1; key?: 'conscription' | 'martial' | 'censorship'; active: (l: Laws) => boolean }
const LW = CONFIG.laws;
export const LAWS: LawDef[] = [
  { id: 'tax_low', group: 'Taxes', name: 'Low taxes', tax: -1, effect: `Income ${pc(LW.taxIncome[0])}, stability +${LW.taxStab[0]}.`, active: (l) => l.tax === -1 },
  { id: 'tax_normal', group: 'Taxes', name: 'Normal taxes', tax: 0, effect: 'No modifiers.', active: (l) => l.tax === 0 },
  { id: 'tax_high', group: 'Taxes', name: 'High taxes', tax: 1, effect: `Income ${pc(LW.taxIncome[2])}, stability ${LW.taxStab[2]}.`, active: (l) => l.tax === 1 },
  { id: 'conscription', group: 'Army', name: 'Conscription', key: 'conscription', effect: `Manpower x${LW.conscriptManpower}, recruiting ${pc(1 - LW.conscriptRecruit)} cheaper, stability ${LW.conscriptStab}.`, active: (l) => l.conscription },
  { id: 'martial', group: 'Order', name: 'Martial law', key: 'martial', effect: `Unrest -${LW.martialUnrest}/month everywhere, stability ${LW.martialStab}, slower growth.`, active: (l) => l.martial },
  { id: 'censorship', group: 'Order', name: 'Press censorship', key: 'censorship', effect: `Half as much foreign chaos gets in, foreign ops are easier to catch, stability ${LW.censorStab}.`, active: (l) => l.censorship },
];
/** Cost of recruiting 1k troops in a given land (barracks and conscription make it cheaper). */
export const recruitUnitCost = (a: Country, T: Country) =>
  a.unitCost * CONFIG.eco.recruitMonths * Math.max(0.4, 1 - T.buildings.barracks * CONFIG.build.barracksRecruit) * (a.laws.conscription ? CONFIG.laws.conscriptRecruit : 1);

// ---------- helpers ----------
export const nationGdp = (s: GameState, id: string) => territoriesOf(s, id).reduce((v, t) => v + t.gdp, 0);
export const nationTroops = (s: GameState, id: string) => territoriesOf(s, id).reduce((v, t) => v + t.troops, 0);
export const strength = (s: GameState, id: string) => milOf(nationTroops(s, id), s.countries[id].tech);
const scaled = (gdp: number, k: number) => k * Math.pow(Math.max(0.5, gdp), CONFIG.costScale.exp);
const spyLvl = (x: Ctx) => x.N.spies[x.a.id] ?? 0;
const inf = (x: Ctx) => x.N.influence[x.a.id] ?? 0;
const addInf = (x: Ctx, v: number) => (x.N.influence[x.a.id] = clamp(inf(x) + v, 0, 100));
const ok = (msg: string, extra: Partial<ActionResult> = {}): ActionResult => ({ ok: true, msg, ...extra });
const fail = (msg: string, extra: Partial<ActionResult> = {}): ActionResult => ({ ok: false, msg, ...extra });
const home = (x: Ctx) => x.s.countries[x.N.id]; // home territory record of the target nation
const pct = (v: number) => `${Math.round(v * 100)}%`;

function detectRisk(x: Ctx, base: number): number {
  const d = isPlayer(x.s, x.a.id) ? CONFIG.difficulty[x.s.difficulty].detection : 1;
  return clamp(base * (1 - spyLvl(x) * CONFIG.covert.spyDetectReduction) * (0.7 + x.N.leader.traits.paranoia * 0.6) * d * (x.N.laws.censorship ? CONFIG.laws.censorDetect : 1), 0.02, 0.95);
}

/** Rolls detection + attribution. Bots only react to what they actually found out (fog of war). */
function exposure(x: Ctx, base: number, what: string, relPenalty: number, grudge: number, infamy: number): boolean {
  const { s, a, N } = x;
  if (!chance(s, detectRisk(x, base))) {
    if (isPlayer(s, N.id)) addNews(s, 'chaos', `Trouble in ${x.T.name}: ${what}. Nobody knows who is behind it.`, 2, [x.T.id]);
    return false;
  }
  if (isPlayer(s, a.id)) s.stats.opsDetected++;
  if (chance(s, CONFIG.covert.attribution + N.tech * 0.02)) {
    addRel(s, a.id, N.id, -relPenalty);
    addGrudge(s, N.id, a.id, grudge);
    a.infamy += infamy;
    addNews(s, 'covert', `${N.name} exposes ${a.name} as the hand behind ${what} in ${x.T.name}.`, isPlayer(s, a.id) || isPlayer(s, N.id) ? 3 : 2, [a.id, N.id]);
  } else {
    const suspects = nations(s).filter((o) => o.id !== N.id && rel(s, o.id, N.id) < -5);
    if (suspects.length && chance(s, CONFIG.covert.paranoiaAttribution + N.leader.traits.paranoia * 0.3)) {
      const sus = suspects.reduce((m, o) => (rel(s, o.id, N.id) < rel(s, m.id, N.id) ? o : m));
      addRel(s, sus.id, N.id, -relPenalty / 2);
      addNews(s, 'covert', `${N.name} uncovers foreign agents behind ${what} and blames ${sus.name}.`, isPlayer(s, sus.id) || isPlayer(s, N.id) ? 3 : 1, [N.id, sus.id]);
    } else {
      addNews(s, 'covert', `${N.name} uncovers foreign agents behind ${what} but cannot trace them.`, isPlayer(s, N.id) ? 3 : 1, [N.id]);
    }
  }
  return true;
}

const notOwnBloc = (x: Ctx) => (x.N.overlord === x.a.id ? 'This is your own puppet' : null);
const notAtWar = (x: Ctx) => (x.a.wars.includes(x.N.id) ? 'You are at war with them' : null);
const first = (...r: (string | null)[]) => r.find((v) => v) ?? null;

// ---------- diplomacy acceptance (bots evaluating a proposal) ----------
export type ProposalKind = 'alliance' | 'trade' | 'pact' | 'loan' | 'peace' | 'vassal';

export function acceptance(s: GameState, kind: ProposalKind, from: Country, to: Country): { ok: boolean; why: string } {
  const r = rel(s, from.id, to.id);
  const tr = to.leader.traits;
  const grudge = to.memory.grudges[from.id] ?? 0;
  switch (kind) {
    case 'alliance': {
      const common = from.wars.some((w) => to.wars.includes(w)) || (s.coalition != null && s.coalition.members.includes(to.id) && s.coalition.target !== from.id && rel(s, from.id, s.coalition.target) < 0);
      const score = r - CONFIG.diplomacy.allianceMin + tr.diplomacy * 20 + (common ? 20 : 0) - from.infamy * 0.5 - grudge * 0.5 - (to.memory.betrayedBy.includes(from.id) ? 40 : 0);
      if (to.allies.length >= 4) return { ok: false, why: 'they already have enough allies' };
      if (s.coalition?.target === from.id && s.coalition.members.includes(to.id)) return { ok: false, why: 'they are in the coalition against you' };
      return score >= 0 ? { ok: true, why: 'relations are warm enough' } : { ok: false, why: `relations too cool (need about ${Math.round(r - score)})` };
    }
    case 'trade': {
      if (to.sanctions.includes(from.id) || from.sanctions.includes(to.id)) return { ok: false, why: 'sanctions are in place' };
      if (to.trade.length >= CONFIG.eco.tradeMaxDeals) return { ok: false, why: 'their trade capacity is full' };
      return r >= CONFIG.diplomacy.tradeMin - tr.greed * 15 ? { ok: true, why: 'profit talks' } : { ok: false, why: 'relations too poor' };
    }
    case 'pact': {
      const ratio = strength(s, from.id) / Math.max(0.01, strength(s, to.id));
      if (grudge > 50) return { ok: false, why: 'they hold a grudge' };
      return r >= -10 || ratio > 1.5 ? { ok: true, why: ratio > 1.5 ? 'they fear you' : 'relations allow it' } : { ok: false, why: 'they do not trust you' };
    }
    case 'loan': {
      if (to.debt) return { ok: false, why: 'they are already indebted' };
      if (r < -30) return { ok: false, why: 'they refuse your money' };
      const poor = to.treasury < to.lastIncome * 3;
      return poor || tr.greed > 0.55 ? { ok: true, why: poor ? 'they need the cash' : 'greed' } : { ok: false, why: 'they see the trap' };
    }
    case 'peace': {
      const mine = strength(s, to.id), theirs = strength(s, from.id);
      const losing = mine < theirs * 0.8;
      const lostLand = s.countries[to.id].owner !== to.id;
      const score = to.warExhaustion + (losing ? 25 : -10) + (lostLand ? 20 : 0) - tr.aggression * 25 - grudge * 0.15 + tr.diplomacy * 10;
      return score >= CONFIG.ai.peaceExhaustion * 0.6 ? { ok: true, why: losing ? 'they are losing' : 'they are exhausted' } : { ok: false, why: 'they still believe they can win' };
    }
    case 'vassal': {
      const ratio = strength(s, from.id) / Math.max(0.01, strength(s, to.id));
      if (ratio < CONFIG.influence.vassalPowerRatio) return { ok: false, why: `you need ${CONFIG.influence.vassalPowerRatio}x their military (now ${ratio.toFixed(1)}x)` };
      const allies = to.allies.reduce((v, id) => v + strength(s, id), 0);
      const infl = to.influence[from.id] ?? 0;
      const score = Math.min(40, ratio * 4) + r * 0.3 + infl * 0.5 - tr.ambition * 40 + (to.wars.length ? 15 : 0) + (to.stability < 35 ? 10 : 0) - (allies > strength(s, from.id) * 0.5 ? 30 : 0) - 42;
      return score > 0 ? { ok: true, why: 'they see no alternative' } : { ok: false, why: 'they would rather fight' };
    }
  }
}

export function applyProposal(s: GameState, kind: ProposalKind, from: string, to: string) {
  const A = s.countries[from], B = s.countries[to];
  if (!A.alive || !B.alive) return;
  switch (kind) {
    case 'alliance':
      if (!A.allies.includes(to)) { A.allies.push(to); B.allies.push(from); }
      addRel(s, from, to, 15);
      A.memory.promises[to] = s.turn; B.memory.promises[from] = s.turn;
      addNews(s, 'diplo', `${A.name} and ${B.name} sign a military alliance.`, 2, [from, to]);
      break;
    case 'trade':
      if (!A.trade.includes(to)) { A.trade.push(to); B.trade.push(from); }
      addRel(s, from, to, 8);
      addNews(s, 'econ', `${A.name} and ${B.name} sign a trade deal.`, 1, [from, to]);
      break;
    case 'pact':
      A.pacts[to] = s.turn + CONFIG.diplomacy.pactTurns; B.pacts[from] = s.turn + CONFIG.diplomacy.pactTurns;
      addRel(s, from, to, 10);
      addNews(s, 'diplo', `${A.name} and ${B.name} sign a non-aggression treaty.`, 1, [from, to]);
      break;
    case 'peace': {
      const ba = [from, ...nations(s).filter((n) => n.overlord === from).map((n) => n.id)];
      const bb = [to, ...nations(s).filter((n) => n.overlord === to).map((n) => n.id)];
      for (const x of ba) for (const y of bb) if (s.countries[x].wars.includes(y)) endWar(s, x, y);
      addNews(s, 'diplo', `${A.name} and ${B.name} make peace.`, 2, [from, to]);
      break;
    }
    case 'loan': {
      const amount = Math.max(0.05, B.lastIncome * 3);
      A.treasury -= amount; B.treasury += amount;
      B.debt = { to: from, amount };
      B.influence[from] = clamp((B.influence[from] ?? 0) + 12, 0, 100);
      addRel(s, from, to, 6);
      addNews(s, 'econ', `${B.name} takes a ${fmtMoney(amount)} loan from ${A.name}.`, 1, [from, to]);
      break;
    }
    case 'vassal':
      makePuppet(s, to, from);
      A.infamy += CONFIG.overstretch.infamyPuppet;
      addNews(s, 'diplo', `${B.name} bows to ${A.name} and becomes its vassal.`, 3, [from, to]);
      s.fx.push({ kind: 'conquer', to });
      break;
  }
}

/** Sends a proposal: bots answer at once, the player gets a choice prompt. */
function propose(x: Ctx, kind: ProposalKind, label: string): ActionResult {
  const { s, a, N } = x;
  if (isPlayer(s, N.id)) {
    const text: Record<ProposalKind, string> = {
      alliance: `${a.leader.title} ${a.leader.name} of ${a.name} proposes a military alliance.`,
      trade: `${a.name} proposes a trade deal (+${Math.round(CONFIG.eco.tradeBonus * 100)}% income for both).`,
      pact: `${a.name} proposes a ${CONFIG.diplomacy.pactTurns}-month non-aggression treaty.`,
      loan: `${a.name} offers you a loan. It comes with strings attached.`,
      peace: `${a.name} sues for peace.`,
      vassal: `${a.name} demands that you become its vassal.`,
    };
    if (s.choices.some((c) => c.eventId === 'proposal:' + kind && c.targetId === a.id)) return fail('Already proposed');
    s.choices.push({
      id: s.choiceSeq++, eventId: 'proposal:' + kind, title: label, text: text[kind], targetId: a.id,
      options: [
        { label: 'Accept', desc: '', effect: `accept:${kind}:${a.id}` },
        { label: 'Refuse', desc: kind === 'vassal' ? 'They will not forget.' : '', effect: `refuse:${kind}:${a.id}` },
      ],
    });
    return ok('Proposal sent');
  }
  const acc = acceptance(s, kind, a, N);
  if (!acc.ok) {
    if (kind === 'vassal') { addRel(s, a.id, N.id, -25); addGrudge(s, N.id, a.id, 20); }
    return fail(`${N.name} refuses: ${acc.why}.`);
  }
  applyProposal(s, kind, a.id, N.id);
  return ok(`${N.name} accepts.`);
}

function battleInput(x: Ctx, from: Country, amount: number): BattleInput {
  return {
    attTroops: amount, defTroops: x.T.troops, attTech: x.a.tech, defTech: x.N.tech,
    attStability: x.a.stability, defStability: x.T.stability, terrain: x.T.terrain,
    amphibious: !from.neighbors.includes(x.T.id), defHome: x.T.id === x.N.id,
    attDisrupted: from.disrupted > 0, defDisrupted: x.T.disrupted > 0, fort: x.T.buildings.barracks,
  };
}

/** Own territories from which `tid` can be attacked / reached. */
export function launchPoints(s: GameState, actor: string, tid: string): Country[] {
  const T = s.countries[tid];
  return links(T).map((id) => s.countries[id]).filter((c) => c.owner === actor);
}

/** What-if preview used by the UI and the advisors. */
export function previewAttack(s: GameState, actor: string, fromId: string, tid: string, amount: number) {
  const T = s.countries[tid];
  const x: Ctx = { s, a: s.countries[actor], T, N: s.countries[T.owner], p: {} };
  const input = battleInput(x, s.countries[fromId], amount);
  return { ...battleOdds(input), input };
}

// ---------- the action table ----------
const A: Impl[] = [
  // ===== POLITICAL =====
  {
    id: 'diplomacy', cat: 'political', name: 'Diplomatic mission', desc: 'Improve relations.', ap: 1, scope: 'foreign',
    cost: (x) => scaled(nationGdp(x.s, x.N.id), 0.01),
    why: (x) => notAtWar(x),
    run: (x) => {
      const g = x.N.memory.grudges[x.a.id] ?? 0;
      const v = randRange(x.s, 8, 13) * (1 - g / 140) * (0.7 + x.N.leader.traits.diplomacy * 0.6);
      addRel(x.s, x.a.id, x.N.id, v);
      return ok(`Relations with ${x.N.name} improve by ${v.toFixed(0)}.`);
    },
  },
  {
    id: 'propaganda', cat: 'political', name: 'Propaganda campaign', desc: 'Grow your political influence.', ap: 1, scope: 'foreign',
    cost: (x) => scaled(nationGdp(x.s, x.N.id), 0.02), risk: (x) => detectRisk(x, 0.1),
    why: (x) => notOwnBloc(x),
    run: (x) => {
      const v = randRange(x.s, 6, 10) * (1.15 - home(x).stability / 250);
      addInf(x, v);
      const det = exposure(x, 0.1, 'a propaganda campaign', 5, 5, 0);
      return ok(`Influence in ${x.N.name} +${v.toFixed(0)} (now ${inf(x).toFixed(0)}).`, { detected: det });
    },
  },
  {
    id: 'bribe', cat: 'political', name: 'Bribe officials', desc: 'Buy a large chunk of influence.', ap: 1, scope: 'foreign',
    cost: (x) => scaled(nationGdp(x.s, x.N.id), 0.06), risk: (x) => detectRisk(x, 0.2),
    why: (x) => notOwnBloc(x),
    run: (x) => {
      const v = randRange(x.s, 11, 16) * (0.6 + x.N.leader.traits.greed * 0.8);
      addInf(x, v);
      const det = exposure(x, 0.2, 'a bribery scandal', 12, 10, 1);
      return ok(`Officials in ${x.N.name} are on your payroll. Influence +${v.toFixed(0)} (now ${inf(x).toFixed(0)}).`, { detected: det });
    },
  },
  {
    id: 'fund_opposition', cat: 'political', name: 'Fund opposition', desc: 'Weaken the regime: unrest up, stability down.', ap: 1, scope: 'foreign',
    cost: (x) => scaled(nationGdp(x.s, x.N.id), 0.04), risk: (x) => detectRisk(x, 0.25),
    why: (x) => notOwnBloc(x),
    run: (x) => {
      const h = home(x);
      h.unrest = clamp(h.unrest + 8, 0, 100);
      h.stability = clamp(h.stability - 3, 0, 100);
      addInf(x, 4);
      const det = exposure(x, 0.25, 'foreign funding of the opposition', 15, 15, 1);
      return ok(`The opposition in ${x.N.name} grows bolder (unrest ${h.unrest.toFixed(0)}).`, { detected: det });
    },
  },
  {
    id: 'election', cat: 'political', name: 'Election interference', desc: 'Try to install a friendly government.', ap: 2, scope: 'foreign',
    cost: (x) => scaled(nationGdp(x.s, x.N.id), 0.08), risk: () => 0.5,
    chance: (x) => clamp(0.22 + inf(x) / 200 + spyLvl(x) * CONFIG.covert.spySuccessBonus, 0.05, 0.9),
    why: (x) => first(notOwnBloc(x), notAtWar(x), x.N.government === 'democracy' || x.N.government === 'hybrid' ? null : 'They do not hold real elections'),
    run: (x) => {
      const { s, a, N } = x;
      if (chance(s, A_BY_ID.election.chance!(x))) {
        N.leader = makeLeader(s, N.government);
        N.leader.traits.loyalty = clamp(N.leader.traits.loyalty + 0.2, 0, 1);
        N.memory.grudges[a.id] = 0;
        addInf(x, 25);
        addRel(s, a.id, N.id, 25);
        addNews(s, 'diplo', `Surprise election result in ${N.name}: ${N.leader.title} ${N.leader.name} takes office.`, 2, [N.id]);
        return ok(`Your candidate wins in ${N.name}. Influence now ${inf(x).toFixed(0)}.`);
      }
      const det = exposure(x, 0.5, 'election meddling', 25, 25, 4);
      return fail(`The interference in ${N.name} fails${det ? ' and is exposed' : ''}.`, { detected: det });
    },
  },
  {
    id: 'coup', cat: 'political', name: 'Sponsor a coup', desc: 'Topple the government and install a puppet.', ap: 2, scope: 'foreign',
    cost: (x) => scaled(nationGdp(x.s, x.N.id), 0.15), risk: () => 1,
    chance: (x) => clamp(0.08 + (inf(x) - 30) / 140 + (50 - home(x).stability) / 120 + spyLvl(x) * 0.05 - x.N.leader.traits.paranoia * 0.15 - (x.N.overlord ? 0.2 : 0), 0.03, 0.9),
    why: (x) => first(notOwnBloc(x), allied(x.s, x.a.id, x.N.id) ? 'They are your ally' : null,
      inf(x) >= CONFIG.influence.coupMin || home(x).stability <= 30 ? null : `Needs influence ${CONFIG.influence.coupMin}+ or target stability 30 or less`),
    run: (x) => {
      const { s, a, N } = x;
      if (chance(s, A_BY_ID.coup.chance!(x))) {
        const old = N.leader.name;
        N.leader = makeLeader(s, N.government);
        N.leader.traits.loyalty = clamp(N.leader.traits.loyalty + 0.3, 0, 1);
        N.memory = { grudges: {}, betrayedBy: [], promises: {} };
        makePuppet(s, N.id, a.id);
        a.infamy += CONFIG.overstretch.infamyPuppet;
        home(x).unrest = clamp(home(x).unrest + 10, 0, 100);
        if (isPlayer(s, a.id)) s.stats.puppets++;
        addNews(s, 'event', `Coup in ${N.name}! ${old} is deposed; the new regime aligns with ${a.name}.`, 3, [a.id, N.id]);
        s.fx.push({ kind: 'conquer', to: N.id });
        return ok(`The coup succeeds. ${N.name} is now your puppet.`);
      }
      addRel(s, a.id, N.id, -40);
      addGrudge(s, N.id, a.id, 40);
      a.infamy += 8;
      addInf(x, -20);
      if (isPlayer(s, a.id)) s.stats.opsDetected++;
      addNews(s, 'covert', `A coup attempt in ${N.name} fails. The plotters are traced to ${a.name}.`, 3, [a.id, N.id]);
      return fail(`The coup in ${N.name} fails and your role is exposed.`, { detected: true });
    },
  },
  {
    id: 'alliance', cat: 'political', name: 'Forge alliance', desc: 'Allies join your defensive wars.', ap: 1, scope: 'foreign',
    why: (x) => first(notAtWar(x), x.a.allies.includes(x.N.id) ? 'Already allied' : null, x.N.overlord ? 'Puppets cannot sign alliances' : null, x.a.overlord ? 'Your overlord forbids it' : null),
    chance: (x) => (isPlayer(x.s, x.N.id) ? 0.5 : acceptance(x.s, 'alliance', x.a, x.N).ok ? 1 : 0),
    run: (x) => propose(x, 'alliance', 'Alliance offer'),
  },
  {
    id: 'break_alliance', cat: 'political', name: 'Break alliance', desc: 'End the alliance. Costs reputation.', ap: 1, scope: 'foreign',
    why: (x) => (x.a.allies.includes(x.N.id) ? null : 'Not allied'),
    run: (x) => {
      const { s, a, N } = x;
      a.allies.splice(a.allies.indexOf(N.id), 1);
      N.allies.splice(N.allies.indexOf(a.id), 1);
      addRel(s, a.id, N.id, -30);
      a.infamy += 3;
      N.memory.betrayedBy.push(a.id);
      addNews(s, 'diplo', `${a.name} breaks its alliance with ${N.name}.`, 2, [a.id, N.id]);
      return ok(`Alliance with ${N.name} ended.`);
    },
  },
  {
    id: 'pact', cat: 'political', name: 'Sign non-aggression treaty', desc: `${CONFIG.diplomacy.pactTurns} months of guaranteed peace. Breaking it is a betrayal.`, ap: 1, scope: 'foreign',
    why: (x) => first(notAtWar(x), (x.a.pacts[x.N.id] ?? 0) > x.s.turn ? 'Treaty already in force' : null),
    chance: (x) => (isPlayer(x.s, x.N.id) ? 0.5 : acceptance(x.s, 'pact', x.a, x.N).ok ? 1 : 0),
    run: (x) => propose(x, 'pact', 'Treaty offer'),
  },
  {
    id: 'trade', cat: 'political', name: 'Trade deal', desc: `+${Math.round(CONFIG.eco.tradeBonus * 100)}% income for both sides (max ${CONFIG.eco.tradeMaxDeals} deals).`, ap: 1, scope: 'foreign',
    why: (x) => first(notAtWar(x), x.a.trade.includes(x.N.id) ? 'Already trading' : null, x.a.trade.length >= CONFIG.eco.tradeMaxDeals ? 'Your trade capacity is full' : null),
    chance: (x) => (isPlayer(x.s, x.N.id) ? 0.5 : acceptance(x.s, 'trade', x.a, x.N).ok ? 1 : 0),
    run: (x) => propose(x, 'trade', 'Trade offer'),
  },
  {
    id: 'sanction', cat: 'political', name: 'Impose sanctions', desc: 'Cut their income; ends trade and sours relations.', ap: 1, scope: 'foreign',
    why: (x) => first(notOwnBloc(x), x.a.sanctions.includes(x.N.id) ? 'Already sanctioned' : null),
    run: (x) => {
      const { s, a, N } = x;
      a.sanctions.push(N.id);
      if (a.trade.includes(N.id)) { a.trade.splice(a.trade.indexOf(N.id), 1); N.trade.splice(N.trade.indexOf(a.id), 1); }
      addRel(s, a.id, N.id, -20);
      addGrudge(s, N.id, a.id, 10);
      addNews(s, 'econ', `${a.name} imposes sanctions on ${N.name}.`, isPlayer(s, N.id) ? 3 : 1, [a.id, N.id]);
      return ok(`Sanctions on ${N.name} are in force.`);
    },
  },
  {
    id: 'lift_sanction', cat: 'political', name: 'Lift sanctions', desc: 'Remove your sanctions.', ap: 1, scope: 'foreign',
    why: (x) => (x.a.sanctions.includes(x.N.id) ? null : 'No sanctions in place'),
    run: (x) => {
      x.a.sanctions.splice(x.a.sanctions.indexOf(x.N.id), 1);
      addRel(x.s, x.a.id, x.N.id, 8);
      return ok(`Sanctions on ${x.N.name} lifted.`);
    },
  },
  {
    id: 'debt_trap', cat: 'political', name: 'Debt-trap loan', desc: 'Lend money: steady interest and growing influence.', ap: 1, scope: 'foreign',
    cost: (x) => Math.max(0.05, x.N.lastIncome * 3),
    why: (x) => first(notAtWar(x), notOwnBloc(x), x.N.debt ? 'They are already indebted' : null),
    chance: (x) => (isPlayer(x.s, x.N.id) ? 0.5 : acceptance(x.s, 'loan', x.a, x.N).ok ? 1 : 0),
    run: (x) => {
      x.a.treasury += A_BY_ID.debt_trap.cost!(x); // the loan itself moves the money (see applyProposal)
      return propose(x, 'loan', 'Loan offer');
    },
  },
  {
    id: 'vassalize', cat: 'political', name: 'Demand vassalage', desc: `Bully a much weaker state into becoming your puppet (needs ${CONFIG.influence.vassalPowerRatio}x their military).`, ap: 2, scope: 'foreign',
    why: (x) => first(notOwnBloc(x), x.a.overlord ? 'You are a vassal yourself' : null, allied(x.s, x.a.id, x.N.id) ? 'They are your ally' : null),
    chance: (x) => (isPlayer(x.s, x.N.id) ? 0.1 : acceptance(x.s, 'vassal', x.a, x.N).ok ? 1 : 0),
    run: (x) => {
      const r = propose(x, 'vassal', 'Ultimatum');
      if (r.ok && isPlayer(x.s, x.a.id) && !isPlayer(x.s, x.N.id)) x.s.stats.puppets++;
      return r;
    },
  },
  {
    id: 'absorb', cat: 'political', name: 'Annex puppet', desc: `Absorb a puppet into your empire (needs influence ${CONFIG.influence.absorbMin}+).`, ap: 2, scope: 'foreign',
    why: (x) => first(x.N.overlord === x.a.id ? null : 'Only your own puppets can be absorbed', inf(x) >= CONFIG.influence.absorbMin ? null : `Influence ${inf(x).toFixed(0)}/${CONFIG.influence.absorbMin}`),
    run: (x) => {
      const { s, a, N } = x;
      for (const t of territoriesOf(s, N.id)) {
        setOwner(s, t.id, a.id, 'annexed');
        t.integration = 40;
        t.unrest = clamp(t.unrest + 8, 0, 100);
        s.fx.push({ kind: 'conquer', to: t.id });
      }
      a.treasury += Math.max(0, N.treasury);
      killNation(s, N.id, null);
      a.infamy += CONFIG.overstretch.infamyAnnex / 2;
      if (isPlayer(s, a.id)) s.stats.annexed++;
      addNews(s, 'diplo', `${a.name} formally annexes its puppet ${N.name}.`, 3, [a.id, N.id]);
      return ok(`${N.name} is absorbed into your empire.`);
    },
  },
  {
    id: 'peace', cat: 'political', name: 'Sue for peace', desc: 'End the war; everyone keeps what they hold.', ap: 1, scope: 'foreign',
    why: (x) => first(x.a.wars.includes(x.N.id) ? null : 'Not at war', x.N.overlord ? 'Negotiate with their overlord' : null, x.a.overlord ? 'Your overlord decides' : null),
    chance: (x) => (isPlayer(x.s, x.N.id) ? 0.5 : acceptance(x.s, 'peace', x.a, x.N).ok ? 1 : 0),
    run: (x) => propose(x, 'peace', 'Peace offer'),
  },
  // ===== COVERT =====
  {
    id: 'spy', cat: 'covert', name: 'Build spy network', desc: `Raises success and lowers detection of all ops here (level ${0}-${CONFIG.covert.spyMax}).`, ap: 1, scope: 'foreign',
    cost: (x) => scaled(nationGdp(x.s, x.N.id), 0.03) * (1 + spyLvl(x) * 0.5), risk: (x) => detectRisk(x, 0.15),
    why: (x) => (spyLvl(x) >= CONFIG.covert.spyMax ? 'Network at maximum level' : null),
    run: (x) => {
      if (exposure(x, 0.15, 'a spy ring', 8, 8, 0)) return fail(`Your agents in ${x.N.name} are rounded up.`, { detected: true });
      x.N.spies[x.a.id] = spyLvl(x) + 1;
      return ok(`Spy network in ${x.N.name} is now level ${spyLvl(x)}.`);
    },
  },
  {
    id: 'sabotage', cat: 'covert', name: 'Sabotage infrastructure', desc: 'Damage GDP and supplies in this land.', ap: 1, scope: 'foreign',
    cost: (x) => scaled(x.T.gdp, 0.05), risk: (x) => detectRisk(x, 0.3),
    chance: (x) => clamp(0.55 + spyLvl(x) * CONFIG.covert.spySuccessBonus, 0, 0.95),
    run: (x) => {
      const won = chance(x.s, A_BY_ID.sabotage.chance!(x));
      if (won) { x.T.gdp *= 0.96; x.T.troops *= 0.97; x.T.stability = clamp(x.T.stability - 2, 0, 100); }
      const det = exposure(x, 0.3, 'sabotage of infrastructure', 20, 20, 2);
      return won ? ok(`Sabotage in ${x.T.name} succeeds: GDP -4%.`, { detected: det }) : fail(`The sabotage in ${x.T.name} is foiled.`, { detected: det });
    },
  },
  {
    id: 'disinfo', cat: 'covert', name: 'Disinformation', desc: 'Turn the target against its closest friend.', ap: 1, scope: 'foreign',
    cost: (x) => scaled(nationGdp(x.s, x.N.id), 0.03), risk: (x) => detectRisk(x, 0.2),
    chance: (x) => clamp(0.6 + spyLvl(x) * CONFIG.covert.spySuccessBonus, 0, 0.95),
    run: (x) => {
      const { s, a, N } = x;
      const friends = [...new Set([...N.allies, ...N.trade])].filter((f) => f !== a.id && s.countries[f].alive);
      const won = chance(s, A_BY_ID.disinfo.chance!(x));
      let msg = `The disinformation campaign in ${N.name} gains no traction.`;
      if (won) {
        if (friends.length) {
          const f = friends.reduce((m, o) => (rel(s, o, N.id) > rel(s, m, N.id) ? o : m));
          addRel(s, N.id, f, -15);
          msg = `Forged leaks poison relations between ${N.name} and ${s.countries[f].name}.`;
        } else {
          home(x).stability = clamp(home(x).stability - 3, 0, 100);
          msg = `Fake scandals erode trust in the government of ${N.name}.`;
        }
      }
      const det = exposure(x, 0.2, 'a disinformation campaign', 12, 12, 1);
      return won ? ok(msg, { detected: det }) : fail(msg, { detected: det });
    },
  },
  {
    id: 'assassinate', cat: 'covert', name: 'Assassinate minister', desc: 'Decapitate the regime: big stability hit, may change the leader.', ap: 2, scope: 'foreign',
    cost: (x) => scaled(nationGdp(x.s, x.N.id), 0.08), risk: (x) => detectRisk(x, 0.5),
    chance: (x) => clamp(0.3 + spyLvl(x) * 0.07, 0, 0.9),
    run: (x) => {
      const { s, N } = x;
      const won = chance(s, A_BY_ID.assassinate.chance!(x));
      if (won) {
        const h = home(x);
        h.stability = clamp(h.stability - 12, 0, 100);
        h.unrest = clamp(h.unrest + 10, 0, 100);
        if (chance(s, 0.5) && !isPlayer(s, N.id)) {
          N.leader = makeLeader(s, N.government);
          addNews(s, 'event', `${N.name} in shock: its leader is assassinated. ${N.leader.title} ${N.leader.name} succeeds.`, 2, [N.id]);
        } else addNews(s, 'event', `A senior minister of ${N.name} is assassinated.`, isPlayer(s, N.id) ? 3 : 2, [N.id]);
      }
      const det = exposure(x, 0.5, 'a political assassination', 45, 50, 8);
      return won ? ok(`The hit in ${N.name} succeeds. Stability -12.`, { detected: det }) : fail(`The assassination attempt in ${N.name} fails.`, { detected: det });
    },
  },
  {
    id: 'cyber', cat: 'covert', name: 'Cyberattack', desc: 'Drain the treasury and disrupt military command for 3 months.', ap: 1, scope: 'foreign',
    cost: (x) => scaled(nationGdp(x.s, x.N.id), 0.05), risk: (x) => detectRisk(x, 0.25),
    chance: (x) => clamp(0.6 + spyLvl(x) * 0.05 + (x.a.tech - x.N.tech) * 0.03, 0.1, 0.95),
    run: (x) => {
      const won = chance(x.s, A_BY_ID.cyber.chance!(x));
      if (won) {
        const loss = Math.max(x.N.lastIncome, Math.max(0, x.N.treasury) * 0.08);
        x.N.treasury -= loss;
        x.T.disrupted = 3;
      }
      const det = exposure(x, 0.25, 'a cyberattack', 18, 18, 2);
      return won ? ok(`Cyberattack on ${x.N.name} succeeds: funds drained, command in ${x.T.name} disrupted.`, { detected: det }) : fail(`The cyberattack on ${x.N.name} is blocked.`, { detected: det });
    },
  },
  // ===== CHAOS =====
  {
    id: 'protests', cat: 'chaos', name: 'Incite protests', desc: 'Unrest +10 in this land.', ap: 1, scope: 'foreign',
    cost: (x) => scaled(x.T.gdp, 0.025), risk: (x) => detectRisk(x, 0.15),
    run: (x) => {
      const v = randRange(x.s, 8, 12) * (1.2 - x.T.stability / 200);
      x.T.unrest = clamp(x.T.unrest + v, 0, 100);
      const det = exposure(x, 0.15, 'mass protests', 12, 12, 1);
      return ok(`Protests fill the streets of ${x.T.name} (unrest ${x.T.unrest.toFixed(0)}).`, { detected: det });
    },
  },
  {
    id: 'strikes', cat: 'chaos', name: 'Organize strikes', desc: 'GDP -2.5% and unrest +6.', ap: 1, scope: 'foreign',
    cost: (x) => scaled(x.T.gdp, 0.035), risk: (x) => detectRisk(x, 0.2),
    run: (x) => {
      x.T.gdp *= 0.975;
      x.T.unrest = clamp(x.T.unrest + 6, 0, 100);
      const det = exposure(x, 0.2, 'a wave of strikes', 14, 14, 1);
      return ok(`Strikes paralyse ${x.T.name} (unrest ${x.T.unrest.toFixed(0)}).`, { detected: det });
    },
  },
  {
    id: 'refugees', cat: 'chaos', name: 'Refugee crisis', desc: 'Push refugees from a nearby war or chaos zone across the border.', ap: 1, scope: 'foreign',
    cost: (x) => scaled(x.T.gdp, 0.04), risk: (x) => detectRisk(x, 0.2),
    why: (x) => (x.N.wars.length || links(x.T).some((l) => x.s.countries[l].unrest > 50 || x.s.countries[x.s.countries[l].owner].wars.length) ? null : 'Needs a war or chaos zone (unrest 50+) next door'),
    run: (x) => {
      x.T.unrest = clamp(x.T.unrest + 9, 0, 100);
      x.T.stability = clamp(x.T.stability - 3, 0, 100);
      for (const l of x.T.neighbors) {
        const o = x.s.countries[l];
        if (o.owner !== x.a.id) o.unrest = clamp(o.unrest + 3, 0, 100);
      }
      const det = exposure(x, 0.2, 'an engineered refugee crisis', 15, 15, 2);
      return ok(`A refugee wave overwhelms ${x.T.name} and its neighbours.`, { detected: det });
    },
  },
  {
    id: 'misinfo', cat: 'chaos', name: 'Misinformation wave', desc: 'Unrest +5 and doubles how fast chaos spreads from/into here for 4 months.', ap: 1, scope: 'foreign',
    cost: (x) => scaled(x.T.gdp, 0.03), risk: (x) => detectRisk(x, 0.15),
    run: (x) => {
      x.T.mediaInfected = 4;
      x.T.unrest = clamp(x.T.unrest + 5, 0, 100);
      const det = exposure(x, 0.15, 'a viral misinformation wave', 10, 10, 1);
      return ok(`Rumours go viral in ${x.T.name}. Chaos will spread faster.`, { detected: det });
    },
  },
  // ===== MILITARY =====
  {
    id: 'declare_war', cat: 'military', name: 'Declare war', desc: 'Open hostilities. Their allies may join; your reputation suffers.', ap: 2, scope: 'foreign',
    why: (x) => first(x.a.wars.includes(x.N.id) ? 'Already at war' : null, notOwnBloc(x), x.a.overlord ? 'Your overlord decides on war' : null,
      x.a.allies.includes(rootOf(x.s, x.N.id)) ? 'Break the alliance first' : null,
      (x.a.truces[rootOf(x.s, x.N.id)] ?? 0) > x.s.turn ? `Truce until month ${x.a.truces[rootOf(x.s, x.N.id)]}` : null),
    run: (x) => {
      const target = rootOf(x.s, x.N.id);
      const joined = declareWar(x.s, x.a.id, target);
      if (isPlayer(x.s, x.a.id)) x.s.stats.warsDeclared++;
      return ok(`War declared on ${x.s.countries[target].name}.${joined.length ? ` ${joined.map((j) => x.s.countries[j].name).join(', ')} join against you.` : ''}`);
    },
  },
  {
    id: 'attack', cat: 'military', name: 'Attack', desc: 'Launch an assault from an adjacent land you hold.', ap: 1, scope: 'foreign',
    why: (x) => first(x.a.wars.includes(x.N.id) ? null : 'Declare war first', launchPoints(x.s, x.a.id, x.T.id).some((c) => c.troops > 0.2) ? null : 'No troops in an adjacent land you hold'),
    run: (x) => {
      const { s, a, T, N } = x;
      const pts = launchPoints(s, a.id, T.id);
      const from = (x.p.from && pts.find((c) => c.id === x.p.from)) || pts.reduce((m, c) => (c.troops > m.troops ? c : m));
      const amount = clamp(x.p.amount ?? from.troops * 0.75, 0.1, from.troops);
      if (amount <= 0.1) return fail('No troops available there.');
      const res = resolveBattle(s, battleInput(x, from, amount));
      from.troops -= amount;
      const involved = isPlayer(s, a.id) || isPlayer(s, N.id);
      T.gdp *= 1 - CONFIG.eco.warDamage;
      a.warExhaustion = clamp(a.warExhaustion + 2 + 6 * ((res.attStart - res.attLeft) / Math.max(1, nationTroops(s, a.id) + amount)), 0, 100);
      N.warExhaustion = clamp(N.warExhaustion + 3 + (res.win ? 5 : 0), 0, 100);
      s.fx.push({ kind: 'arc', from: from.id, to: T.id, color: '#ff3b4e' }, { kind: 'pulse', to: T.id });
      const line = `${a.name} attacks ${T.name} with ${fmtTroops(amount)} against ${fmtTroops(res.defStart)}`;
      if (res.win) {
        addNews(s, 'combat', `${line} and wins (losses ${fmtTroops(res.attStart - res.attLeft)} vs ${fmtTroops(res.defStart)}).`, involved ? 3 : 1, [a.id, N.id, T.id]);
        if (isPlayer(s, a.id)) s.stats.battlesWon++;
        if (isPlayer(s, N.id)) s.stats.battlesLost++;
        conquer(s, a.id, T.id, Math.max(0.1, res.attLeft));
        return ok(`Victory! ${T.name} is occupied.`, { combat: res });
      }
      from.troops += res.attLeft;
      T.troops = res.defLeft;
      addNews(s, 'combat', `${line} and is repulsed (losses ${fmtTroops(res.attStart - res.attLeft)} vs ${fmtTroops(res.defStart - res.defLeft)}).`, involved ? 3 : 1, [a.id, N.id, T.id]);
      if (isPlayer(s, a.id)) s.stats.battlesLost++;
      if (isPlayer(s, N.id)) s.stats.battlesWon++;
      return fail(`The assault on ${T.name} is repulsed.`, { combat: res });
    },
  },
  {
    id: 'recruit', cat: 'military', name: 'Recruit troops', desc: 'Raise new troops here.', ap: 1, scope: 'own',
    cost: (x) => recruitAmount(x) * recruitUnitCost(x.a, x.T),
    why: (x) => first(x.T.status === 'occupied' ? 'Cannot recruit in occupied land' : null, recruitAmount(x) < 0.05 ? 'Manpower exhausted (5% of population)' : null),
    run: (x) => {
      const n = recruitAmount(x);
      x.T.troops += n;
      return ok(`${fmtTroops(n)} troops raised in ${x.T.name}.`);
    },
  },
  {
    id: 'move', cat: 'military', name: 'Deploy troops here', desc: 'Move troops in from another land you hold (air/naval transport costs money if not adjacent).', ap: 0, scope: 'own',
    cost: (x) => {
      const from = x.p.from ? x.s.countries[x.p.from] : null;
      if (!from || links(x.T).includes(from.id)) return 0;
      return (x.p.amount ?? 0) * x.a.unitCost * 2;
    },
    why: (x) => (territoriesOf(x.s, x.a.id).some((t) => t.id !== x.T.id && t.troops > 0.2) ? null : 'No other troops to move'),
    run: (x) => {
      const from = x.p.from ? x.s.countries[x.p.from] : null;
      if (!from || from.owner !== x.a.id || from.id === x.T.id) return fail('Pick a source territory.');
      const n = clamp(x.p.amount ?? from.troops / 2, 0, from.troops);
      from.troops -= n;
      x.T.troops += n;
      x.s.fx.push({ kind: 'arc', from: from.id, to: x.T.id, color: '#00e5ff' });
      return ok(`${fmtTroops(n)} troops moved from ${from.name} to ${x.T.name}.`);
    },
  },
  {
    id: 'annex', cat: 'military', name: 'Annex', desc: 'Make this occupied land part of your empire. Adds overstretch and infamy.', ap: 1, scope: 'own',
    why: (x) => (x.T.status === 'occupied' ? null : 'Only occupied lands can be annexed'),
    run: (x) => {
      x.T.status = 'annexed';
      x.T.integration = 0;
      x.T.unrest = clamp(x.T.unrest + 8, 0, 100);
      x.a.infamy += CONFIG.overstretch.infamyAnnex;
      if (isPlayer(x.s, x.a.id)) x.s.stats.annexed++;
      addNews(x.s, 'war', `${x.a.name} annexes ${x.T.name}.`, 2, [x.a.id, x.T.id]);
      x.s.fx.push({ kind: 'conquer', to: x.T.id });
      return ok(`${x.T.name} is annexed. It will integrate over time.`);
    },
  },
  {
    id: 'puppet', cat: 'military', name: 'Install puppet government', desc: 'Restore this country as your vassal: tribute and loyalty, far less overstretch.', ap: 1, scope: 'own',
    why: (x) => (x.T.status !== 'home' ? null : 'Not a conquered land'),
    run: (x) => {
      const { s, a, T } = x;
      const garrison = T.troops;
      restoreNation(s, T.id, a.id);
      T.troops = Math.max(1, T.population * 0.5);
      T.unrest = clamp(T.unrest - 15, 0, 100);
      const back = territoriesOf(s, a.id).filter((t) => links(T).includes(t.id)).sort((p, q) => q.troops - p.troops)[0] ?? s.countries[a.id];
      back.troops += garrison;
      a.infamy += CONFIG.overstretch.infamyPuppet;
      if (isPlayer(s, a.id)) s.stats.puppets++;
      addNews(s, 'diplo', `${a.name} installs a puppet government in ${T.name}.`, 2, [a.id, T.id]);
      s.fx.push({ kind: 'conquer', to: T.id });
      return ok(`${T.name} is now your puppet. Your garrison withdraws to ${back.name}.`);
    },
  },
  {
    id: 'release', cat: 'military', name: 'Liberate', desc: 'Give this land its independence back. Restores reputation.', ap: 1, scope: 'own',
    why: (x) => (x.T.status !== 'home' ? null : 'Not a conquered land'),
    run: (x) => {
      const { s, a, T } = x;
      const garrison = T.troops;
      restoreNation(s, T.id, null);
      T.troops = Math.max(1, T.population * 0.5);
      s.countries[a.id].troops += garrison;
      addRel(s, a.id, T.id, 40);
      a.infamy = Math.max(0, a.infamy - 6);
      addNews(s, 'diplo', `${a.name} restores the independence of ${T.name}.`, 2, [a.id, T.id]);
      s.fx.push({ kind: 'conquer', to: T.id });
      return ok(`${T.name} is free again.`);
    },
  },
  // ===== DOMESTIC =====
  ...BUILDINGS.map((b): Impl => ({
    id: 'build_' + b.id, cat: 'develop', name: b.name, desc: b.effect, ap: 1, scope: 'own',
    cost: (x) => buildCost(x.T, b.id),
    why: (x) => first(x.T.status === 'occupied' ? 'Annex or release this land first' : null, x.T.buildings[b.id] >= CONFIG.build.max ? 'Already at maximum level' : null),
    run: (x) => {
      const lvl = ++x.T.buildings[b.id];
      if (b.id === 'farm') x.T.resources.food = clamp(x.T.resources.food + CONFIG.build.farmFood, 0, 10);
      if (b.id === 'industry') { x.T.gdp *= 1 + CONFIG.build.industryGdp; x.T.resources.industry = clamp(x.T.resources.industry + 1, 0, 10); }
      return ok(`${b.name} in ${x.T.name} is now level ${lvl}.`);
    },
  })),
  {
    id: 'law', cat: 'develop', name: 'Change law', desc: 'Change a nation-wide law.', ap: 1, scope: 'own',
    why: (x) => {
      const l = LAWS.find((q) => q.id === x.p.law);
      if (!l) return 'Unknown law';
      return l.active(x.a.laws) && l.tax !== undefined ? 'Already in force' : null;
    },
    run: (x) => {
      const l = LAWS.find((q) => q.id === x.p.law)!;
      const L = x.a.laws;
      let on = true;
      if (l.tax !== undefined) L.tax = l.tax;
      else { on = !L[l.key!]; L[l.key!] = on; }
      const h = x.s.countries[x.a.id];
      if (h.owner === x.a.id) h.unrest = clamp(h.unrest + 2, 0, 100); // every change of law stirs things a little
      addNews(x.s, 'econ', `${x.a.name} ${on ? 'enacts' : 'repeals'}: ${l.name}.`, isPlayer(x.s, x.a.id) ? 2 : 1, [x.a.id]);
      return ok(`${l.name} ${on ? 'is now law' : 'is repealed'}. ${on ? l.effect : ''}`);
    },
  },
  {
    id: 'research', cat: 'domestic', name: 'Military research', desc: `Tech +${CONFIG.eco.researchGain}: better dice in every battle.`, ap: 1, scope: 'own',
    cost: (x) => nationGdp(x.s, x.a.id) * CONFIG.eco.researchCost * (x.a.tech / 5),
    why: (x) => (x.a.tech >= CONFIG.eco.techMax ? 'Technology at maximum' : null),
    run: (x) => {
      x.a.tech = Math.min(CONFIG.eco.techMax, x.a.tech + CONFIG.eco.researchGain);
      return ok(`Tech level is now ${x.a.tech.toFixed(2)}.`);
    },
  },
  {
    id: 'suppress', cat: 'domestic', name: 'Crack down', desc: `Unrest -${CONFIG.stab.suppressUnrest}, stability ${CONFIG.stab.suppressStability}. Works better with a garrison.`, ap: 1, scope: 'own',
    cost: (x) => scaled(x.T.gdp, 0.01),
    run: (x) => {
      x.T.unrest = clamp(x.T.unrest - CONFIG.stab.suppressUnrest, 0, 100);
      x.T.stability = clamp(x.T.stability + CONFIG.stab.suppressStability, 0, 100);
      return ok(`Order is restored by force in ${x.T.name} (unrest ${x.T.unrest.toFixed(0)}).`);
    },
  },
  {
    id: 'reform', cat: 'domestic', name: 'Reforms and aid', desc: 'Stability +6, unrest -6. Expensive but clean.', ap: 1, scope: 'own',
    cost: (x) => x.T.gdp * 0.008,
    run: (x) => {
      x.T.stability = clamp(x.T.stability + 6, 0, 100);
      x.T.unrest = clamp(x.T.unrest - 6, 0, 100);
      if (x.T.status === 'annexed') x.T.integration = Math.min(100, x.T.integration + 5);
      return ok(`Reforms calm ${x.T.name} (stability ${x.T.stability.toFixed(0)}).`);
    },
  },
];

function recruitAmount(x: Ctx): number {
  const lands = territoriesOf(x.s, x.a.id);
  const cap = manpowerCap(lands, x.a.laws.conscription);
  const room = cap - lands.reduce((v, t) => v + t.troops, 0);
  const want = x.p.amount ?? Math.max(1, cap * 0.08);
  return Math.max(0, Math.min(want, room));
}

const A_BY_ID: Record<string, Impl> = Object.fromEntries(A.map((a) => [a.id, a]));
export const ACTIONS = A.map(({ id, cat, name, desc, ap, scope }) => ({ id, cat, name, desc, ap, scope }));

function ctx(s: GameState, actor: string, tid: string, p: Params = {}): Ctx {
  const T = s.countries[tid];
  return { s, a: s.countries[actor], T, N: s.countries[T.owner], p };
}

function reasonFor(im: Impl, x: Ctx, cost: number): string | null {
  const { s, a } = x;
  if (!a.alive) return 'Your nation is gone';
  const own = x.T.owner === a.id;
  if (im.scope === 'own' && !own) return 'Only in your own lands';
  if (im.scope === 'foreign' && own) return 'Not in your own lands';
  const w = im.why?.(x);
  if (w) return w;
  if (isPlayer(s, a.id) && s.ap < im.ap) return `Needs ${im.ap} AP`;
  if (cost > 0 && a.treasury < cost) return `Needs ${fmtMoney(cost)}`;
  return null;
}

export function viewAction(s: GameState, actor: string, id: string, tid: string, p: Params = {}): ActionView {
  const im = A_BY_ID[id];
  const x = ctx(s, actor, tid, p);
  const cost = im.cost?.(x) ?? 0;
  const scopeOk = (im.scope === 'own') === (x.T.owner === actor);
  return {
    id: im.id, cat: im.cat, name: im.name, desc: im.desc, ap: im.ap, cost,
    chance: scopeOk && im.chance ? im.chance(x) : null, risk: scopeOk && im.risk ? im.risk(x) : null, reason: reasonFor(im, x, cost),
  };
}

/** All actions that make sense for the given territory, with cost / odds / availability. */
export function listActions(s: GameState, actor: string, tid: string): ActionView[] {
  const own = s.countries[tid].owner === actor;
  return A.filter((im) => (im.scope === 'own') === own && im.id !== 'law').map((im) => viewAction(s, actor, im.id, tid));
}

export function doAction(s: GameState, actor: string, id: string, tid: string, p: Params = {}): ActionResult {
  const im = A_BY_ID[id];
  if (!im) return fail('Unknown action');
  if (s.over) return fail('The game is over');
  const x = ctx(s, actor, tid, p);
  const cost = im.cost?.(x) ?? 0;
  const why = reasonFor(im, x, cost);
  if (why) return fail(why);
  x.a.treasury -= cost;
  const player = isPlayer(s, actor);
  if (player) {
    s.ap -= im.ap;
    if (im.cat === 'covert' || im.cat === 'chaos') s.stats.ops++;
  }
  if (im.cat !== 'domestic' && im.cat !== 'develop' && im.id !== 'move' && im.id !== 'recruit' && im.id !== 'attack' && im.id !== 'declare_war') {
    s.fx.push({ kind: 'arc', from: actor, to: tid, color: im.cat === 'political' ? '#00e5ff' : im.cat === 'covert' ? '#c06bff' : '#ffb84d' });
  }
  return im.run(x);
}

export { pct, setWar };
