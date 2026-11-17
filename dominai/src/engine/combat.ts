import { CONFIG } from './config';
import { clamp, d6, rand, type RngHolder } from './rng';
import type { CombatResult, CombatRound } from './types';

export interface BattleInput {
  attTroops: number; // thousands
  defTroops: number;
  attTech: number;
  defTech: number;
  attStability: number; // attacker home stability (morale)
  defStability: number; // defender stability in the contested land (morale + supply)
  terrain: number; // 0/1 defensive terrain
  amphibious: boolean; // attack over a sea link
  defHome: boolean; // defending its own capital land
  attDisrupted?: boolean; // cyber-disrupted command
  defDisrupted?: boolean;
  fort?: number; // barracks level of the defended land
}

/** Die modifiers for both sides. Positive = better rolls. Exposed so the UI can explain the odds. */
export function battleMods(b: BattleInput): { att: number; def: number; notes: string[] } {
  const K = CONFIG.combat;
  const K0 = CONFIG.build;
  const notes: string[] = [];
  let att = 0;
  let def = 0;
  const tech = clamp((b.attTech - b.defTech) * K.techMod, -K.techModMax, K.techModMax);
  if (tech > 0) att += tech;
  else def += -tech;
  if (Math.abs(tech) > 0.05) notes.push(`${tech > 0 ? 'Attacker' : 'Defender'} tech edge ${Math.abs(tech).toFixed(1)}`);
  const am = (b.attStability - 50) * K.moraleMod;
  const dm = (b.defStability - 50) * K.moraleMod;
  att += am;
  def += dm;
  if (dm < -0.15) notes.push('Defender morale and supply are collapsing');
  if (am < -0.15) notes.push('Attacker home front is shaky');
  if (b.terrain) { def += K.terrainMod * b.terrain; notes.push('Difficult terrain favours the defender'); }
  if (b.amphibious) { att -= K.amphibiousMalus; notes.push('Amphibious assault penalty'); }
  if (b.defHome) { def += K.homeFortMod; notes.push('Defender fights for its homeland'); }
  if (b.fort) { def += K0.barracksDef * b.fort; notes.push(`Fortified (barracks level ${b.fort})`); }
  if (b.attDisrupted) { att -= K.disruptedMalus; notes.push('Attacker command is cyber-disrupted'); }
  if (b.defDisrupted) { def -= K.disruptedMalus; notes.push('Defender command is cyber-disrupted'); }
  return { att, def, notes };
}

/**
 * Risk-style dice battle. Armies are chunked into "units" so any battle lasts roughly
 * CONFIG.combat.targetRounds exchanges. Each exchange: attacker rolls up to 3 dice, defender up to 2,
 * dice are sorted and compared pairwise (ties go to the defender); each lost pair costs one unit.
 * The net modifier edge e = attMod - defMod is applied smoothly: the attacker wins a pair when
 * attDie + e + (u - 1) >= defDie with u uniform in [0,1). With e = 0 this is exactly Risk (ties to the
 * defender); e = +0.6 turns 60% of ties into attacker wins; e = -0.6 loses 60% of one-pip leads.
 */
export function resolveBattle(r: RngHolder, b: BattleInput, keepRounds = true): CombatResult {
  const K = CONFIG.combat;
  const mods = battleMods(b);
  const unit = Math.max(0.05, Math.max(b.attTroops, b.defTroops) / K.targetRounds);
  let att = b.attTroops;
  let def = Math.max(0, b.defTroops);
  const rounds: CombatRound[] = [];
  const retreat = b.attTroops * K.retreatAt;
  const edge = mods.att - mods.def;
  let guard = 0;
  while (def > 0.0001 && att > retreat && guard++ < 400) {
    const nA = Math.min(K.attDice, Math.max(1, Math.ceil(att / unit)));
    const nD = Math.min(K.defDice, Math.max(1, Math.ceil(def / unit)));
    const ra: number[] = [];
    const rd: number[] = [];
    for (let i = 0; i < nA; i++) ra.push(d6(r));
    for (let i = 0; i < nD; i++) rd.push(d6(r));
    ra.sort((x, y) => y - x);
    rd.sort((x, y) => y - x);
    let aLost = 0;
    let dLost = 0;
    const won: boolean[] = [];
    for (let i = 0; i < Math.min(nA, nD); i++) {
      const w = ra[i] + edge + (rand(r) - 1) >= rd[i];
      won.push(w);
      if (w) dLost += Math.min(unit, def - dLost);
      else aLost += Math.min(unit, att - aLost);
    }
    att -= aLost;
    def -= dLost;
    if (keepRounds && rounds.length < 60) rounds.push({ att: ra, def: rd, won, attLost: aLost, defLost: dLost });
  }
  if (def < 0.0001) def = 0;
  return {
    win: def === 0 && att > 0, attStart: b.attTroops, defStart: b.defTroops, attLeft: Math.max(0, att), defLeft: def,
    attMod: mods.att, defMod: mods.def, rounds, notes: mods.notes,
  };
}

/** Monte-Carlo estimate of the attacker's win chance; uses its own throw-away RNG (no game-state side effects). */
export function battleOdds(b: BattleInput, samples = CONFIG.combat.oddsSamples): { win: number; attLoss: number; defLoss: number } {
  const r: RngHolder = { rng: (Math.round(b.attTroops * 131 + b.defTroops * 71 + b.attTech * 17 + b.defTech * 13) >>> 0) + 99991 };
  let wins = 0;
  let aL = 0;
  let dL = 0;
  for (let i = 0; i < samples; i++) {
    const res = resolveBattle(r, b, false);
    if (res.win) wins++;
    aL += res.attStart - res.attLeft;
    dL += res.defStart - res.defLeft;
  }
  return { win: wins / samples, attLoss: aL / samples, defLoss: dL / samples };
}
