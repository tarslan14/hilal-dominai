// Headless balance check: runs N AI-vs-AI games (no human player) and reports aggregate stats.
// Usage: npm run simulate -- [games=100] [years=10] [seedPrefix=sim]
import { runBots } from '../src/ai/bot';
import { loadWorld } from '../src/data/world';
import { worldSeeds } from '../src/data/seeds';
import { CONFIG } from '../src/engine/config';
import { computePowers, createGame, nations } from '../src/engine/state';
import { endTurn } from '../src/engine/turn';

const games = Number(process.argv[2] ?? 100);
const years = Number(process.argv[3] ?? 10);
const prefix = process.argv[4] ?? 'sim';
const seeds = worldSeeds(loadWorld());
const t0 = Date.now();

const agg = { wars: 0, alliances: 0, peace: 0, fallen: 0, coups: 0, coalitions: 0, rebellions: 0, puppets: 0, annex: 0, battles: 0, events: 0 };
const topShares: number[] = [];
const startTop: number[] = [];
const winners: Record<string, number> = {};
const top3: Record<string, number> = {};
let runaway = 0;
let gamesWithWar = 0;
let gamesWithAlliance = 0;
let aliveSum = 0;

for (let g = 0; g < games; g++) {
  const s = createGame(seeds, { seed: `${prefix}-${g}`, playerId: null, difficulty: 'normal' });
  if (g === 0) startTop.push(Math.max(...Object.values(computePowers(s)).map((p) => p.share)));
  const c = { wars: 0, alliances: 0 };
  for (let t = 0; t < years * 12; t++) {
    const rep = endTurn(s, runBots);
    for (const n of rep.news) {
      if (n.text.includes('declares war')) { agg.wars++; c.wars++; }
      else if (n.text.includes('military alliance')) { agg.alliances++; c.alliances++; }
      else if (n.text.includes('make peace')) agg.peace++;
      else if (n.text.includes('has fallen')) agg.fallen++;
      else if (n.text.startsWith('Coup in')) agg.coups++;
      else if (n.text.startsWith('A coalition forms')) agg.coalitions++;
      else if (n.text.includes('rises up')) agg.rebellions++;
      else if (n.text.includes('puppet government') || n.text.includes('becomes its vassal') || n.text.includes('aligns with')) agg.puppets++;
      else if (n.text.includes(' annexes ')) agg.annex++;
      if (n.kind === 'combat') agg.battles++;
      if (n.kind === 'event') agg.events++;
    }
  }
  const powers = Object.values(computePowers(s)).filter((p) => !s.countries[p.id].overlord).sort((a, b) => b.share - a.share);
  topShares.push(powers[0].share);
  winners[s.countries[powers[0].id].name] = (winners[s.countries[powers[0].id].name] ?? 0) + 1;
  for (const p of powers.slice(0, 3)) top3[s.countries[p.id].name] = (top3[s.countries[p.id].name] ?? 0) + 1;
  if (powers[0].share >= CONFIG.win.share) runaway++;
  if (c.wars) gamesWithWar++;
  if (c.alliances) gamesWithAlliance++;
  aliveSum += nations(s).length;
  if ((g + 1) % 10 === 0) process.stdout.write(`  ...${g + 1}/${games} games\n`);
}

const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const pct = (v: number) => (v * 100).toFixed(1) + '%';
const sorted = topShares.slice().sort((a, b) => a - b);
const per = (k: keyof typeof agg) => (agg[k] / games).toFixed(1);
console.log(`\n=== dominAI balance simulation: ${games} games x ${years} years (${((Date.now() - t0) / 1000).toFixed(1)}s) ===`);
console.log(`Per game: wars ${per('wars')} | battles ${per('battles')} | peace deals ${per('peace')} | alliances ${per('alliances')} | coalitions ${per('coalitions')}`);
console.log(`          nations fallen ${per('fallen')} | annexations ${per('annex')} | puppets ${per('puppets')} | rebellions ${per('rebellions')} | coups ${per('coups')} | events ${per('events')}`);
console.log(`Nations alive at end: ${(aliveSum / games).toFixed(1)} of ${seeds.length}`);
console.log(`Games with at least one war: ${pct(gamesWithWar / games)} | with a new alliance: ${pct(gamesWithAlliance / games)}`);
console.log(`Top power's empire share: start ${pct(startTop[0])} -> end avg ${pct(avg(topShares))}, median ${pct(sorted[Math.floor(sorted.length / 2)])}, max ${pct(sorted[sorted.length - 1])}`);
console.log(`Runaway games (a bot reached the ${pct(CONFIG.win.share)} win threshold): ${runaway} (${pct(runaway / games)})`);
const table = (o: Record<string, number>) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([n, v]) => `${n} ${pct(v / games)}`).join(', ');
console.log(`#1 power at end (win rate): ${table(winners)}`);
console.log(`Top-3 finish rate: ${table(top3)}`);
