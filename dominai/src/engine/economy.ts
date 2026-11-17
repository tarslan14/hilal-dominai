import { CONFIG } from './config';
import { clamp } from './rng';
import { addNews, nations, ownership } from './state';
import type { Country, GameState } from './types';

export interface Budget {
  gross: number; // tax income from owned lands (after modifiers)
  tribute: number; // + from puppets / - to overlord
  interest: number; // + from debtors / - to lender
  upkeep: number;
  net: number;
  sanctionPenalty: number; // 0..max share of income lost to sanctions
}

/** Income factor of a single territory for its owner (status, unrest, stability). */
export function territoryYield(t: Country): number {
  const E = CONFIG.eco;
  const status = t.status === 'home' ? 1 : t.status === 'occupied' ? E.occupiedIncome : E.annexedIncomeMin + (1 - E.annexedIncomeMin) * (t.integration / 100);
  return status * (1 - t.unrest / 160) * (0.6 + 0.4 * (t.stability / 100)) * (1 + t.resources.oil * E.oilIncome) * (1 + t.buildings.industry * CONFIG.build.industryIncome);
}

export function budgetOf(s: GameState, id: string, own: Map<string, Country[]> = ownership(s)): Budget {
  const E = CONFIG.eco;
  const N = s.countries[id];
  const lands = own.get(id) ?? [];
  let base = 0;
  let troops = 0;
  let gdp = 0;
  for (const t of lands) {
    base += t.gdp * E.taxRate * territoryYield(t);
    troops += t.troops;
    gdp += t.gdp;
  }
  // sanctions: each sanctioning power hurts in proportion to its economic weight relative to the target
  let pen = 0;
  for (const o of nations(s)) {
    if (!o.sanctions.includes(id)) continue;
    let og = 0;
    for (const t of own.get(o.id) ?? []) og += t.gdp;
    pen += E.sanctionPenalty * clamp(og / Math.max(1, gdp), 0.2, 3);
  }
  pen = Math.min(E.sanctionMaxPenalty, pen);
  const trade = 1 + E.tradeBonus * Math.min(E.tradeMaxDeals, N.trade.length);
  const D = CONFIG.difficulty[s.difficulty];
  const diff = s.playerId ? (id === s.playerId ? D.playerIncome : D.botIncome) : 1;
  const gross = base * trade * (1 - pen) * diff * CONFIG.laws.taxIncome[N.laws.tax + 1];
  let tribute = 0;
  if (N.overlord) tribute -= gross * E.puppetTribute;
  for (const p of nations(s)) {
    if (p.overlord !== id) continue;
    let pb = 0;
    for (const t of own.get(p.id) ?? []) pb += t.gdp * E.taxRate * territoryYield(t);
    tribute += pb * E.puppetTribute;
  }
  let interest = 0;
  if (N.debt) interest -= N.debt.amount * E.debtInterest;
  for (const o of nations(s)) if (o.debt?.to === id) interest += o.debt.amount * E.debtInterest;
  const upkeep = troops * N.unitCost;
  return { gross, tribute, interest, upkeep, net: gross + tribute + interest - upkeep, sanctionPenalty: pen };
}

/** Max troops a nation can field: a share of the population it controls. */
export function manpowerCap(lands: Country[], conscription = false): number {
  let pop = 0;
  for (const t of lands) pop += t.population * (t.status === 'home' ? 1 : t.status === 'annexed' ? 0.6 : 0.2) * (1 + t.buildings.farm * CONFIG.build.farmManpower);
  // population in millions -> troops in thousands
  return pop * 1000 * CONFIG.eco.manpowerShare * (conscription ? CONFIG.laws.conscriptManpower : 1);
}

export function economyTick(s: GameState) {
  const E = CONFIG.eco;
  const own = ownership(s);
  for (const N of nations(s)) {
    const b = budgetOf(s, N.id, own);
    N.treasury += b.net;
    N.lastIncome = b.gross + b.tribute + b.interest;
    N.lastUpkeep = b.upkeep;
    const limit = -Math.max(0.05, b.gross) * E.debtLimitMonths;
    if (N.treasury < limit) {
      N.brokeTurns++;
      // unpaid soldiers desert
      for (const t of own.get(N.id) ?? []) t.troops = Math.max(0.2, t.troops * 0.93);
      if (N.id === s.playerId) addNews(s, 'econ', `Your treasury is exhausted (${N.brokeTurns}/${E.bankruptcyTurns} months to collapse). Unpaid troops are deserting.`, 3, [N.id]);
    } else if (N.brokeTurns > 0) N.brokeTurns--;
  }
  // growth, integration
  for (const id of s.ids) {
    const t = s.countries[id];
    const owner = s.countries[t.owner];
    const war = owner.wars.length > 0 ? 0.0012 : 0;
    t.gdp *= 1 + E.baseGrowth * (t.stability / 100) * (1 - t.unrest / 100) - war - (t.unrest > 70 ? 0.004 : 0) + t.buildings.industry * CONFIG.build.industryGrowth - (owner.laws.martial ? CONFIG.laws.martialGrowth : 0);
    if (t.status === 'annexed' && t.integration < 100) {
      t.integration = Math.min(100, t.integration + E.integrationPerTurn * (1 - t.unrest / 130));
    }
  }
}
