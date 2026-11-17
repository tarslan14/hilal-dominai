// Rule-based, offline advisor personas + threat radar. They only read the game state and
// suggest; nothing here mutates it.
import { acceptance, launchPoints, previewAttack, viewAction, strength, type Params } from '../engine/actions';
import { CONFIG } from '../engine/config';
import { budgetOf } from '../engine/economy';
import { allied, computePowers, fmtMoney, fmtTroops, links, nations, ownership, rel, rootOf, territoriesOf, type PowerInfo } from '../engine/state';
import { garrisonRatio, overstretchOf } from '../engine/tick';
import type { Country, GameState } from '../engine/types';
import { warDesire } from './bot';

export type Persona = 'military' | 'intel' | 'economy' | 'diplomat';
export const PERSONAS: Record<Persona, { name: string; title: string; cls: string }> = {
  military: { name: 'Gen. Varga', title: 'Military', cls: 'mil' },
  intel: { name: 'Director Nyx', title: 'Intelligence', cls: 'int' },
  economy: { name: 'Dr. Okafor', title: 'Economy', cls: 'eco' },
  diplomat: { name: 'Amb. Laurent', title: 'Diplomat', cls: 'dip' },
};

export interface Advice {
  who: Persona;
  title: string;
  why: string;
  score: number;
  chance?: number;
  cost?: number;
  risk?: string;
  objection?: boolean; // this advisor disagrees with a colleague
  focus?: string; // territory to fly to
  act?: { id: string; tid: string; p?: Params };
}

export interface Threat {
  id: string;
  score: number; // 0..1 likelihood-ish
  reasons: string[];
  atWar: boolean;
}

/** Who is most likely to attack the player next, and why. */
export function threatRadar(s: GameState, powers: Record<string, PowerInfo> = computePowers(s)): Threat[] {
  if (!s.playerId) return [];
  const me = s.countries[s.playerId];
  const own = ownership(s);
  const reach = new Set<string>();
  for (const t of own.get(me.id) ?? []) for (const l of links(t)) reach.add(rootOf(s, s.countries[l].owner));
  const out: Threat[] = [];
  for (const N of nations(s)) {
    if (N.id === me.id || N.overlord || N.overlord === me.id) continue;
    const war = N.wars.includes(me.id);
    if (!reach.has(N.id) && !war) continue;
    if (allied(s, N.id, me.id) && !war) continue;
    const d = warDesire({ s, N, lands: own.get(N.id) ?? [], powers, own }, me);
    const reasons = d.reasons.slice();
    let score = war ? 1 : Math.max(0, Math.min(0.95, (d.u + 0.3) / 1.1));
    if ((N.truces[me.id] ?? 0) > s.turn) { score *= 0.2; reasons.push('bound by a truce'); }
    if ((N.pacts[me.id] ?? 0) > s.turn) { score *= 0.4; reasons.push('non-aggression treaty in force'); }
    if (d.ratio < 0.8 && !war) reasons.push('but is weaker than you');
    if (war) reasons.unshift('AT WAR with you');
    if (score > 0.08) out.push({ id: N.id, score, reasons: reasons.length ? reasons : ['opportunism'], atWar: war });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 8);
}

export function advise(s: GameState): Advice[] {
  if (!s.playerId || s.over) return [];
  const me = s.countries[s.playerId];
  const powers = computePowers(s);
  const lands = territoriesOf(s, me.id);
  const budget = budgetOf(s, me.id);
  const threats = threatRadar(s, powers);
  const out: Advice[] = [];
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const act = (id: string, tid: string, p?: Params) => ({ id, tid, p });
  const view = (id: string, tid: string, p?: Params) => viewAction(s, me.id, id, tid, p);
  const myStr = strength(s, me.id);
  const months = budget.net < 0 ? me.treasury / -budget.net : Infinity;

  // frontier: foreign territories touching mine
  const frontier = new Map<string, Country>();
  for (const t of lands) for (const l of links(t)) {
    const o = s.countries[l];
    if (o.owner !== me.id) frontier.set(o.id, o);
  }
  const neighbours = new Map<string, Country>(); // root nations in reach
  for (const t of frontier.values()) neighbours.set(rootOf(s, t.owner), s.countries[rootOf(s, t.owner)]);

  const bestAttack = (T: Country) => {
    const pts = launchPoints(s, me.id, T.id).filter((c) => c.troops > 0.3);
    if (!pts.length) return null;
    const from = pts.reduce((m, c) => (c.troops > m.troops ? c : m));
    const amount = from.troops * 0.8;
    return { from, amount, odds: previewAttack(s, me.id, from.id, T.id, amount) };
  };

  // ================= MILITARY =================
  let topWarPlan: { N: Country; odds: number } | null = null;
  for (const T of frontier.values()) {
    const N = s.countries[T.owner];
    if (N.overlord === me.id) continue;
    const b = bestAttack(T);
    if (!b) continue;
    if (me.wars.includes(N.id)) {
      if (b.odds.win < 0.35) continue;
      out.push({
        who: 'military', title: `Attack ${T.name}`, score: 0.9 + b.odds.win * 0.6 + (T.id === N.id ? 0.2 : 0), chance: b.odds.win, focus: T.id,
        why: `${fmtTroops(b.amount)} from ${b.from.name} against ${fmtTroops(T.troops)} defenders. Their stability is ${T.stability.toFixed(0)}${T.terrain ? ', but the terrain is rough' : ''}. Expected losses ${fmtTroops(b.odds.attLoss)}.${T.id === N.id ? ' Taking the capital ends ' + N.name + '.' : ''}`,
        risk: b.odds.win > 0.7 ? 'low' : b.odds.win > 0.5 ? 'medium' : 'high', act: act('attack', T.id, { from: b.from.id, amount: b.amount }),
      });
    } else if (T.id === N.id && !allied(s, me.id, N.id) && !N.overlord) {
      const v = view('declare_war', N.id);
      if (v.reason && !v.reason.startsWith('Needs')) continue;
      const allies = N.allies.map((a) => s.countries[a]).filter((a) => a.alive);
      const busy = allies.filter((a) => a.wars.length > 0);
      const allyStr = allies.reduce((x, a) => x + strength(s, a.id), 0);
      if (b.odds.win < 0.6 || allyStr > myStr * 0.8) continue;
      const score = 0.25 + b.odds.win * 0.5 + (50 - T.stability) / 150 + Math.min(0.2, N.gdp / Math.max(1, powers[me.id].gdp)) - (allies.length - busy.length) * 0.1;
      const allyTxt = !allies.length ? 'it has no allies' : busy.length === allies.length ? `its allies are distracted by war` : `its allies (${allies.map((a) => a.name).join(', ')}) may join`;
      out.push({
        who: 'military', title: `Invade ${N.name}`, score, chance: b.odds.win, focus: N.id,
        why: `Its stability is ${T.stability.toFixed(0)}, ${allyTxt}, and your odds of taking the capital are ~${pct(b.odds.win)} with ${fmtTroops(b.amount)} from ${b.from.name}.`,
        risk: `infamy +${CONFIG.overstretch.infamyWar}`, act: act('declare_war', N.id),
      });
      if (!topWarPlan || score > 0) topWarPlan = topWarPlan && topWarPlan.odds > b.odds.win ? topWarPlan : { N, odds: b.odds.win };
    }
  }
  const worst = threats[0];
  if (worst && worst.score > 0.35) {
    const v = view('recruit', me.id);
    const W = s.countries[worst.id];
    const ratio = strength(s, worst.id) / Math.max(0.01, myStr);
    if (!v.reason && ratio > 0.6) out.push({
      who: 'military', title: 'Recruit troops', score: 0.5 + worst.score * 0.5 + Math.min(0.3, ratio * 0.1), cost: v.cost, focus: me.id,
      why: `${W.name} is your most likely attacker (${worst.reasons[0]}). Their army is ${ratio.toFixed(1)}x yours in fighting strength.`, act: act('recruit', me.id),
    });
    // move reserves to the threatened border
    const border = lands.filter((t) => links(t).some((l) => rootOf(s, s.countries[l].owner) === worst.id)).sort((a, b) => a.troops - b.troops)[0];
    const reserve = lands.filter((t) => t !== border && !links(t).some((l) => s.countries[l].owner !== me.id && rel(s, me.id, s.countries[l].owner) < -20)).sort((a, b) => b.troops - a.troops)[0];
    if (border && reserve && reserve.troops > border.troops * 1.5 && reserve.troops > 2) out.push({
      who: 'military', title: `Reinforce ${border.name}`, score: 0.45 + worst.score * 0.4, focus: border.id,
      why: `Only ${fmtTroops(border.troops)} hold the border with ${W.name} while ${fmtTroops(reserve.troops)} sit idle in ${reserve.name}.`,
      act: act('move', border.id, { from: reserve.id, amount: reserve.troops * 0.5 }),
    });
  }
  for (const t of lands) {
    if (t.status === 'home') continue;
    const gr = garrisonRatio(t);
    if (t.unrest > 55 && gr < 0.8) out.push({
      who: 'military', title: `Garrison ${t.name}`, score: 0.6 + t.unrest / 150, focus: t.id, risk: 'rebellion',
      why: `Unrest is ${t.unrest.toFixed(0)} and the garrison covers only ${pct(gr)} of what is needed. At ${CONFIG.stab.rebellionThreshold} it will revolt.`,
      act: view('suppress', t.id).reason ? undefined : act('suppress', t.id),
    });
    if (t.status === 'occupied') {
      out.push({ who: 'military', title: `Annex ${t.name}`, score: 0.7, focus: t.id, risk: `infamy +${CONFIG.overstretch.infamyAnnex}`, why: `Its ${fmtMoney(t.gdp)} economy and manpower become yours outright. Occupied land yields only ${pct(CONFIG.eco.occupiedIncome)} income.`, act: act('annex', t.id) });
      out.push({ who: 'diplomat', title: `Make ${t.name} a puppet instead`, score: 0.68 + overstretchOf(lands) * 0.1, objection: true, focus: t.id, why: `The General wants annexation, but a puppet pays ${pct(CONFIG.eco.puppetTribute)} tribute, fights your wars, causes no overstretch and half the infamy.`, act: act('puppet', t.id) });
    }
  }
  {
    const home = s.countries[me.id];
    const bk = view('build_barracks', me.id);
    if (worst && worst.score > 0.4 && !bk.reason && me.treasury > bk.cost * 2) out.push({ who: 'military', title: `Fortify ${home.name}`, score: 0.4 + worst.score * 0.3, cost: bk.cost, focus: me.id, why: `Barracks level ${home.buildings.barracks} -> ${home.buildings.barracks + 1}: +${CONFIG.build.barracksDef} on your defence dice and ${pct(CONFIG.build.barracksRecruit)} cheaper recruits.`, act: act('build_barracks', me.id) });
    if (me.wars.length && !me.laws.conscription) out.push({ who: 'military', title: 'Introduce conscription', score: 0.5, risk: `stability ${CONFIG.laws.conscriptStab}`, why: `We are at war. Conscription multiplies manpower by ${CONFIG.laws.conscriptManpower} and cuts recruiting cost.`, act: act('law', me.id, { law: 'conscription' }) });
  }
  const res = view('research', me.id);
  if (!res.reason && me.treasury > res.cost * 3) out.push({ who: 'military', title: 'Fund military research', score: 0.35, cost: res.cost, why: `Tech ${me.tech.toFixed(1)} -> ${(me.tech + CONFIG.eco.researchGain).toFixed(2)}. Every tech level is worth +${CONFIG.combat.techMod} on each die.`, act: act('research', me.id) });

  // ================= INTELLIGENCE =================
  if (worst && worst.score > 0.3) {
    const v = view('spy', worst.id);
    if (!v.reason && (s.countries[worst.id].spies[me.id] ?? 0) < 2) out.push({ who: 'intel', title: `Spy network in ${s.countries[worst.id].name}`, score: 0.5 + worst.score * 0.3, cost: v.cost, risk: pct(v.risk ?? 0) + ' detection', focus: worst.id, why: `They are your top threat. A network cuts detection of every later operation by ${pct(CONFIG.covert.spyDetectReduction)} per level and raises success.`, act: act('spy', worst.id) });
  }
  for (const N of neighbours.values()) {
    if (N.overlord === me.id || allied(s, me.id, N.id) || N.id === me.id) continue;
    const coup = view('coup', N.id);
    if (!coup.reason && (coup.chance ?? 0) > 0.3) out.push({
      who: 'intel', title: `Coup in ${N.name}`, score: 0.4 + (coup.chance ?? 0) * 0.9, chance: coup.chance ?? 0, cost: coup.cost, risk: 'exposed if it fails', focus: N.id,
      why: `Influence ${(N.influence[me.id] ?? 0).toFixed(0)}, their stability ${N.stability.toFixed(0)}. Success makes ${N.name} your puppet without firing a shot.`, act: act('coup', N.id),
    });
    else if ((N.influence[me.id] ?? 0) >= 20 && (N.influence[me.id] ?? 0) < CONFIG.influence.coupMin) {
      const b = view('bribe', N.id);
      if (!b.reason) out.push({ who: 'intel', title: `Bribe officials in ${N.name}`, score: 0.4 + (N.influence[me.id] ?? 0) / 150, cost: b.cost, risk: pct(b.risk ?? 0) + ' detection', focus: N.id, why: `Influence is ${(N.influence[me.id] ?? 0).toFixed(0)}; at ${CONFIG.influence.coupMin} a coup becomes possible.`, act: act('bribe', N.id) });
    }
    const r = rel(s, me.id, N.id);
    if (r < -20 || me.wars.includes(N.id)) {
      const h = s.countries[N.id];
      const pr = view('protests', N.id);
      if (!pr.reason && h.unrest > 22 && h.unrest < 80) out.push({
        who: 'intel', title: `Incite protests in ${N.name}`, score: 0.3 + h.unrest / 160 + (me.wars.includes(N.id) ? 0.25 : 0), cost: pr.cost, risk: pct(pr.risk ?? 0) + ' detection', focus: N.id,
        why: `Unrest is ${h.unrest.toFixed(0)}${h.unrest + 10 > CONFIG.chaos.threshold ? `; past ${CONFIG.chaos.threshold} it becomes contagious and spreads to ${h.neighbors.length} neighbours` : ''}. Low stability also weakens their defence dice.`, act: act('protests', N.id),
      });
      const cy = view('cyber', N.id);
      if (!cy.reason && me.wars.includes(N.id)) out.push({ who: 'intel', title: `Cyberattack on ${N.name}`, score: 0.55, chance: cy.chance ?? 0, cost: cy.cost, risk: pct(cy.risk ?? 0) + ' detection', focus: N.id, why: `Disrupts their command for 3 months (-${CONFIG.combat.disruptedMalus} on their dice) right before you strike.`, act: act('cyber', N.id) });
    }
  }
  if (me.infamy > CONFIG.coalition.minInfamy * 0.6 && !s.coalition) out.push({ who: 'intel', title: 'Coalition warning', score: 0.75, objection: !!topWarPlan, why: `Your infamy is ${me.infamy.toFixed(0)}; around ${CONFIG.coalition.minInfamy} our sources expect a coalition against you. Every war and annexation adds to it. Lie low or liberate a conquest.` });

  // ================= ECONOMY =================
  if (budget.net < 0 && me.laws.tax < 1) out.push({ who: 'economy', title: 'Raise taxes', score: 0.8, risk: `stability ${CONFIG.laws.taxStab[2]}`, why: `High taxes lift income to ${pct(CONFIG.laws.taxIncome[2])} and would ease the deficit.`, act: act('law', me.id, { law: 'tax_high' }) });
  if (budget.net < 0) out.push({ who: 'economy', title: 'Budget deficit', score: 0.9, why: `You lose ${fmtMoney(-budget.net)} a month (income ${fmtMoney(budget.gross)}, army upkeep ${fmtMoney(budget.upkeep)}). Reserves last ${months === Infinity ? '?' : Math.max(0, months).toFixed(0)} months; after ${CONFIG.eco.bankruptcyTurns} broke months the army deposes you.` });
  if (budget.sanctionPenalty > 0.05) out.push({ who: 'economy', title: 'Sanctions are biting', score: 0.55, why: `Sanctions cost you ${pct(budget.sanctionPenalty)} of your income. Mend fences or break the sanctioning bloc.` });
  const os = overstretchOf(lands);
  if (os > 0.5) out.push({ who: 'economy', title: 'Imperial overstretch', score: 0.5 + os * 0.12, objection: !!topWarPlan, why: `${os.toFixed(1)} overstretch points: home stability target -${Math.min(CONFIG.overstretch.maxMalus, os * CONFIG.overstretch.perTerritory).toFixed(0)} and rising unrest in every held land. Integrate (reforms) or use puppets before conquering more.` });
  if (topWarPlan && months < 12) out.push({ who: 'economy', title: `We cannot afford a war with ${topWarPlan.N.name}`, score: 0.6, objection: true, why: `The General wants to invade, but reserves cover only ${Math.max(0, months).toFixed(0)} months of deficit. Fix the budget first.` });
  if (budget.net > 0 || me.treasury > budget.gross * 4) {
    const best = lands.filter((t) => t.status !== 'occupied').sort((a, b) => b.gdp - a.gdp)[0];
    const v = best && view('build_industry', best.id);
    if (v && !v.reason && me.treasury > v.cost * 2.5) out.push({ who: 'economy', title: `Build industry in ${best.name}`, score: 0.42, cost: v.cost, focus: best.id, why: `Level ${best.buildings.industry} -> ${best.buildings.industry + 1}: income from ${best.name} +${pct(CONFIG.build.industryIncome)} for good, GDP +${pct(CONFIG.build.industryGdp)} now.`, act: act('build_industry', best.id) });
    const hungry = lands.filter((t) => t.status !== 'occupied' && t.buildings.farm < CONFIG.build.max && (t.stability < 50 || t.resources.food < 4)).sort((x, y) => x.stability - y.stability)[0];
    const f = hungry && view('build_farm', hungry.id);
    if (f && !f.reason && me.treasury > f.cost * 2) out.push({ who: 'economy', title: `Develop agriculture in ${hungry.name}`, score: 0.4 + (50 - Math.min(50, hungry.stability)) / 100, cost: f.cost, focus: hungry.id, why: `Stability ${hungry.stability.toFixed(0)}, food ${hungry.resources.food}/10. Each farm level adds +${CONFIG.build.farmStab} stability, more manpower and famine protection.`, act: act('build_farm', hungry.id) });
  }
  if (me.trade.length < CONFIG.eco.tradeMaxDeals) {
    const c = [...neighbours.values()].filter((N) => N.id !== me.id && !N.overlord && !me.trade.includes(N.id) && !me.wars.includes(N.id) && acceptance(s, 'trade', me, N).ok)
      .sort((a, b) => (powers[b.id]?.gdp ?? 0) - (powers[a.id]?.gdp ?? 0))[0];
    if (c) out.push({ who: 'economy', title: `Trade deal with ${c.name}`, score: 0.48, chance: 1, focus: c.id, why: `They will sign. +${pct(CONFIG.eco.tradeBonus)} income (${fmtMoney(budget.gross * CONFIG.eco.tradeBonus)}/month) and warmer relations.`, act: act('trade', c.id) });
  }
  const debtor = [...neighbours.values()].filter((N) => N.id !== me.id && !N.debt && !me.wars.includes(N.id) && N.overlord !== me.id && acceptance(s, 'loan', me, N).ok && me.treasury > N.lastIncome * 9)
    .sort((a, b) => b.gdp - a.gdp)[0];
  if (debtor) out.push({ who: 'economy', title: `Debt-trap ${debtor.name}`, score: 0.36, cost: debtor.lastIncome * 3, chance: 1, focus: debtor.id, why: `They will take the loan: ${pct(CONFIG.eco.debtInterest)} monthly interest plus +1 influence every month they stay indebted.`, act: act('debt_trap', debtor.id) });

  // ================= DIPLOMAT =================
  for (const w of me.wars) {
    const W = s.countries[w];
    if (W.overlord) continue;
    const acc = acceptance(s, 'peace', me, W);
    if (acc.ok && (me.warExhaustion > 25 || strength(s, w) > myStr)) out.push({ who: 'diplomat', title: `Make peace with ${W.name}`, score: 0.6 + me.warExhaustion / 120, chance: 1, objection: true, focus: w, why: `They will accept (${acc.why}). Your war exhaustion is ${me.warExhaustion.toFixed(0)}, dragging stability down. You keep what you hold.`, act: act('peace', w) });
  }
  if (worst && !worst.atWar && worst.score > 0.3) {
    const W = s.countries[worst.id];
    const pact = view('pact', W.id);
    if (!pact.reason && pact.chance === 1) out.push({ who: 'diplomat', title: `Non-aggression treaty with ${W.name}`, score: 0.55 + worst.score * 0.4, chance: 1, focus: W.id, why: `They are the likeliest to attack you and they will sign. ${CONFIG.diplomacy.pactTurns} months of cover.`, act: act('pact', W.id) });
    else {
      const d = view('diplomacy', W.id);
      if (!d.reason) out.push({ who: 'diplomat', title: `Diplomatic mission to ${W.name}`, score: 0.4 + worst.score * 0.35, cost: d.cost, focus: W.id, objection: topWarPlan?.N.id === W.id, why: `Relations are ${rel(s, me.id, W.id).toFixed(0)}. Each mission adds about +10 and lowers their appetite for war.`, act: act('diplomacy', W.id) });
    }
  }
  if (me.allies.length < 3) {
    const c = nations(s).filter((N) => N.id !== me.id && !N.overlord && !me.allies.includes(N.id) && !me.wars.includes(N.id) && rel(s, me.id, N.id) > 15 && acceptance(s, 'alliance', me, N).ok)
      .sort((a, b) => (powers[b.id]?.mil ?? 0) - (powers[a.id]?.mil ?? 0))[0];
    if (c) out.push({ who: 'diplomat', title: `Alliance with ${c.name}`, score: 0.5 + Math.min(0.3, (powers[c.id]?.power ?? 0) * 0.5), chance: 1, focus: c.id, why: `They will accept. World power rank #${powers[c.id]?.rank}; allies answer the call when you are attacked.`, act: act('alliance', c.id) });
  }
  for (const N of neighbours.values()) {
    if (N.id === me.id || N.overlord) continue;
    const v = view('vassalize', N.id);
    if (!v.reason && v.chance === 1) out.push({ who: 'diplomat', title: `Demand vassalage from ${N.name}`, score: 0.7, chance: 1, focus: N.id, risk: `infamy +${CONFIG.overstretch.infamyPuppet}`, why: `You outgun them ${(myStr / Math.max(0.01, strength(s, N.id))).toFixed(0)}:1 and they see no alternative. A bloodless puppet.`, act: act('vassalize', N.id) });
  }
  for (const p of nations(s)) {
    if (p.overlord !== me.id) continue;
    const v = view('absorb', p.id);
    if (!v.reason) out.push({ who: 'diplomat', title: `Annex puppet ${p.name}`, score: 0.5, focus: p.id, risk: 'overstretch', why: `Influence ${(p.influence[me.id] ?? 0).toFixed(0)}: they can be absorbed peacefully. Full income instead of tribute, but they count toward overstretch.`, act: act('absorb', p.id) });
  }
  if (topWarPlan && rel(s, me.id, topWarPlan.N.id) > 15) out.push({ who: 'diplomat', title: `Do not invade ${topWarPlan.N.name}`, score: 0.5, objection: true, focus: topWarPlan.N.id, why: `Relations are a friendly ${rel(s, me.id, topWarPlan.N.id).toFixed(0)}. Attacking a friend costs full infamy and teaches everyone else to fear you.` });

  // keep the best few per persona, ranked
  const per: Record<string, number> = {};
  return out.sort((a, b) => b.score - a.score).filter((a) => (per[a.who] = (per[a.who] ?? 0) + 1) <= 4);
}
