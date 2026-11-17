// Prints a combat odds table (attacker win chance by force ratio and die-modifier edge). Usage: npx tsx scripts/odds.ts
import { battleOdds, type BattleInput } from '../src/engine/combat';

const b: BattleInput = { attTroops: 100, defTroops: 100, attTech: 5, defTech: 5, attStability: 50, defStability: 50, terrain: 0, amphibious: false, defHome: false };
console.log('ratio  even   att+1   def+1');
for (const r of [0.6, 0.8, 1, 1.25, 1.5, 2, 3]) {
  const f = (x: Partial<BattleInput>) => battleOdds({ ...b, attTroops: 100 * r, ...x }, 1500).win.toFixed(2);
  console.log(`${r.toFixed(2)}   ${f({})}   ${f({ attTech: 8.6 })}    ${f({ defTech: 8.6 })}`);
}
