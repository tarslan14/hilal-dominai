import { beforeAll, describe, expect, it } from 'vitest';
import { decide, quickOdds, runBots, warDesire, type BotView } from '../src/ai/bot';
import { advise, threatRadar } from '../src/ai/advisor';
import { worldSeeds } from '../src/data/seeds';
import { countryAt, loadWorld } from '../src/data/world';
import { interpret } from '../src/ai/command';
import { briefing, parseLlm, resolveLlmAction } from '../src/ai/ollama';
import { acceptance, doAction, listActions, viewAction } from '../src/engine/actions';
import { battleMods, battleOdds, resolveBattle, type BattleInput } from '../src/engine/combat';
import { CONFIG } from '../src/engine/config';
import { budgetOf, manpowerCap, territoryYield } from '../src/engine/economy';
import { declareWar } from '../src/engine/nation';
import { computePowers, createGame, ownership, rel, relKey, territoriesOf, type SeedInput } from '../src/engine/state';
import { overstretchOf, spreadChaos } from '../src/engine/tick';
import { endTurn } from '../src/engine/turn';
import type { GameState } from '../src/engine/types';

let seeds: SeedInput[];
const id = (name: string) => seeds.find((s) => s.name === name)!.id;
const game = (player: string | null = null, seed = 'test') => createGame(seeds, { seed, playerId: player ? id(player) : null, difficulty: 'normal' });
const view = (s: GameState, n: string): BotView => {
  const own = ownership(s);
  return { s, N: s.countries[n], lands: own.get(n) ?? [], powers: computePowers(s), own };
};

beforeAll(() => {
  seeds = worldSeeds(loadWorld());
});

describe('world data', () => {
  it('loads ~190 countries with neighbours and a working point lookup', () => {
    const w = loadWorld();
    expect(w.countries.length).toBeGreaterThan(180);
    expect(w.countries.every((c) => c.neighbors.length + c.seaLinks.length > 0)).toBe(true);
    expect(w.byId[countryAt(w, 2.35, 48.85)!].name).toBe('France');
    expect(w.byId[countryAt(w, 100, 62)!].name).toBe('Russia');
    expect(countryAt(w, -30, 30)).toBeNull(); // mid-Atlantic
  });
});

describe('combat', () => {
  const base: BattleInput = { attTroops: 100, defTroops: 100, attTech: 5, defTech: 5, attStability: 50, defStability: 50, terrain: 0, amphibious: false, defHome: false };
  it('is deterministic for a given RNG state', () => {
    const a = resolveBattle({ rng: 42 }, base);
    const b = resolveBattle({ rng: 42 }, base);
    expect(a).toEqual(b);
  });
  it('never creates troops and always ends decisively', () => {
    for (let i = 0; i < 200; i++) {
      const r = resolveBattle({ rng: i * 7919 }, { ...base, attTroops: 10 + i, defTroops: 300 - i });
      expect(r.attLeft).toBeLessThanOrEqual(r.attStart + 1e-9);
      expect(r.defLeft).toBeLessThanOrEqual(r.defStart + 1e-9);
      expect(r.attLeft).toBeGreaterThanOrEqual(0);
      expect(r.win).toBe(r.defLeft === 0 && r.attLeft > 0);
    }
  });
  it('odds rise with numbers, tech and enemy chaos; fall with terrain and sea assaults', () => {
    const even = battleOdds(base, 600).win;
    expect(battleOdds({ ...base, attTroops: 250 }, 600).win).toBeGreaterThan(even + 0.2);
    expect(battleOdds({ ...base, attTech: 9 }, 600).win).toBeGreaterThan(even + 0.15);
    expect(battleOdds({ ...base, defStability: 5 }, 600).win).toBeGreaterThan(even + 0.1);
    expect(battleOdds({ ...base, terrain: 1 }, 600).win).toBeLessThan(even - 0.08);
    expect(battleOdds({ ...base, amphibious: true }, 600).win).toBeLessThan(even - 0.1);
  });
  it('gives the defender the tie (even fight favours defence)', () => {
    expect(battleOdds(base, 800).win).toBeLessThan(0.5);
  });
  it('caps the tech modifier', () => {
    expect(battleMods({ ...base, attTech: 12, defTech: 1 }).att).toBeLessThanOrEqual(CONFIG.combat.techModMax + 1e-9);
  });
});

describe('economy', () => {
  it('income minus upkeep starts positive and upkeep follows troops', () => {
    const s = game();
    const fr = id('France');
    const b = budgetOf(s, fr);
    expect(b.net).toBeGreaterThan(0);
    s.countries[fr].troops *= 2;
    expect(budgetOf(s, fr).upkeep).toBeCloseTo(b.upkeep * 2, 6);
  });
  it('sanctions cut income and trade deals raise it', () => {
    const s = game();
    const pl = id('Poland'), de = id('Germany');
    s.countries[pl].trade = [];
    const b0 = budgetOf(s, pl).gross;
    s.countries[de].sanctions.push(pl);
    const b1 = budgetOf(s, pl);
    expect(b1.gross).toBeLessThan(b0);
    expect(b1.sanctionPenalty).toBeGreaterThan(0);
    s.countries[de].sanctions = [];
    s.countries[pl].trade = [de];
    expect(budgetOf(s, pl).gross).toBeCloseTo(b0 * (1 + CONFIG.eco.tradeBonus), 6);
  });
  it('occupied land yields less than annexed land, which yields less than home', () => {
    const s = game();
    const t = s.countries[id('Belgium')];
    const home = territoryYield(t);
    t.status = 'annexed'; t.integration = 50;
    const annexed = territoryYield(t);
    t.status = 'occupied';
    expect(territoryYield(t)).toBeLessThan(annexed);
    expect(annexed).toBeLessThan(home);
  });
  it('caps manpower at a share of population and puppets pay tribute', () => {
    const s = game();
    const fr = id('France'), be = id('Belgium');
    const base = s.countries[fr].population * 1000 * CONFIG.eco.manpowerShare * (1 + s.countries[fr].buildings.farm * CONFIG.build.farmManpower);
    expect(manpowerCap(territoriesOf(s, fr))).toBeCloseTo(base, 6);
    expect(manpowerCap(territoriesOf(s, fr), true)).toBeCloseTo(base * CONFIG.laws.conscriptManpower, 6);
    s.countries[be].overlord = fr;
    expect(budgetOf(s, fr).tribute).toBeGreaterThan(0);
    expect(budgetOf(s, be).tribute).toBeLessThan(0);
  });
  it('power ranking puts the largest economies and armies on top', () => {
    const p = computePowers(game());
    expect(p[id('United States')].rank).toBeLessThanOrEqual(2);
    expect(p[id('China')].rank).toBeLessThanOrEqual(2);
    const total = Object.values(p).reduce((v, x) => v + x.share, 0);
    expect(total).toBeCloseTo(1, 6);
  });
});

describe('actions and conquest', () => {
  it('war + overwhelming attack occupies the capital and ends the nation', () => {
    const s = game('France');
    const fr = id('France'), be = id('Belgium');
    s.ap = 10;
    expect(doAction(s, fr, 'attack', be).ok).toBe(false); // must declare war first
    expect(doAction(s, fr, 'declare_war', be).ok).toBe(true);
    s.countries[be].troops = 1;
    const res = doAction(s, fr, 'attack', be, { from: fr, amount: 150 });
    expect(res.ok).toBe(true);
    expect(res.combat?.win).toBe(true);
    expect(s.countries[be].owner).toBe(fr);
    expect(s.countries[be].status).toBe('occupied');
    expect(s.countries[be].alive).toBe(false);
    expect(doAction(s, fr, 'puppet', be).ok).toBe(true);
    expect(s.countries[be].alive).toBe(true);
    expect(s.countries[be].overlord).toBe(fr);
  });
  it('charges AP and money, and refuses when the player is out of AP', () => {
    const s = game('France');
    const fr = id('France'), es = id('Spain');
    const t0 = s.countries[fr].treasury;
    const ap0 = s.ap;
    expect(doAction(s, fr, 'propaganda', es).ok).toBe(true);
    expect(s.ap).toBe(ap0 - 1);
    expect(s.countries[fr].treasury).toBeLessThan(t0);
    expect(s.countries[es].influence[fr]).toBeGreaterThan(0);
    s.ap = 0;
    expect(doAction(s, fr, 'propaganda', es).ok).toBe(false);
  });
  it('lists different menus for own and foreign lands', () => {
    const s = game('France');
    const own = listActions(s, id('France'), id('France')).map((a) => a.id);
    const foreign = listActions(s, id('France'), id('Spain')).map((a) => a.id);
    expect(own).toContain('recruit');
    expect(own).not.toContain('coup');
    expect(foreign).toContain('coup');
    expect(foreign).toContain('protests');
  });
  it('annexing beyond the free allowance creates overstretch', () => {
    const s = game();
    const fr = id('France');
    for (const n of ['Belgium', 'Spain', 'Italy', 'Germany']) { s.countries[id(n)].owner = fr; s.countries[id(n)].status = 'occupied'; }
    expect(overstretchOf(territoriesOf(s, fr))).toBeCloseTo(4 - CONFIG.overstretch.freeTerritories, 6);
  });
  it('unrest spreads across borders (chaos transmission)', () => {
    const s = game();
    const fr = s.countries[id('France')];
    fr.unrest = 100;
    let spread = 0;
    for (let i = 0; i < 40; i++) {
      const before = fr.neighbors.reduce((v, n) => v + s.countries[n].unrest, 0);
      spreadChaos(s);
      spread += fr.neighbors.reduce((v, n) => v + s.countries[n].unrest, 0) - before;
    }
    expect(spread).toBeGreaterThan(0);
  });
});

describe('development, laws and the command board', () => {
  it('buildings raise income, fortify and cost more per level', () => {
    const s = game('France');
    const fr = id('France');
    const F = s.countries[fr];
    s.ap = 10;
    F.treasury = 1e6;
    F.buildings = { farm: 0, barracks: 0, industry: 0 };
    const y0 = territoryYield(F);
    const c0 = viewAction(s, fr, 'build_industry', fr).cost;
    expect(doAction(s, fr, 'build_industry', fr).ok).toBe(true);
    expect(F.buildings.industry).toBe(1);
    expect(territoryYield(F)).toBeCloseTo(y0 * (1 + CONFIG.build.industryIncome), 6);
    expect(viewAction(s, fr, 'build_industry', fr).cost).toBeGreaterThan(c0 * 1.9);
    const b = { attTroops: 100, defTroops: 100, attTech: 5, defTech: 5, attStability: 50, defStability: 50, terrain: 0, amphibious: false, defHome: false };
    expect(battleMods({ ...b, fort: 3 }).def).toBeCloseTo(battleMods(b).def + 3 * CONFIG.build.barracksDef, 6);
    F.buildings.farm = CONFIG.build.max;
    expect(doAction(s, fr, 'build_farm', fr).ok).toBe(false);
  });
  it('laws change the budget and can be toggled', () => {
    const s = game('France');
    const fr = id('France');
    s.ap = 10;
    const g0 = budgetOf(s, fr).gross;
    expect(doAction(s, fr, 'law', fr, { law: 'tax_high' }).ok).toBe(true);
    expect(budgetOf(s, fr).gross / g0).toBeGreaterThan(CONFIG.laws.taxIncome[2] - 0.03);
    expect(doAction(s, fr, 'law', fr, { law: 'tax_high' }).ok).toBe(false);
    expect(doAction(s, fr, 'law', fr, { law: 'conscription' }).ok).toBe(true);
    expect(s.countries[fr].laws.conscription).toBe(true);
    doAction(s, fr, 'law', fr, { law: 'conscription' });
    expect(s.countries[fr].laws.conscription).toBe(false);
  });
  it('the command board turns plain orders into actions', () => {
    const s = game('France');
    const fr = id('France'), es = id('Spain'), de = id('Germany');
    expect(interpret(s, 'Raise taxes', null).act).toEqual({ id: 'law', tid: fr, p: { law: 'tax_high' } });
    expect(interpret(s, 'introduce conscription', null).act?.p.law).toBe('conscription');
    expect(interpret(s, 'run a propaganda campaign in Spain', null).act).toEqual({ id: 'propaganda', tid: es, p: {} });
    expect(interpret(s, 'build farms', null).act).toEqual({ id: 'build_farm', tid: fr, p: {} });
    expect(interpret(s, 'grow the economy', null).act?.id).toBe('build_industry');
    expect(interpret(s, 'invade Germany', null).act?.id).toBe('declare_war');
    expect(interpret(s, 'incite protests', es).act).toEqual({ id: 'protests', tid: es, p: {} });
    expect(interpret(s, 'recruit 40k troops', null).act).toEqual({ id: 'recruit', tid: fr, p: { amount: 40 } });
    expect(interpret(s, 'propose a trade deal with the UK', null).act?.tid).toBe(id('United Kingdom'));
    expect(interpret(s, 'end turn', null).endTurn).toBe(true);
    expect(interpret(s, 'sing me a song', null).ok).toBe(false);
    // deploying: war first, then an attack order with an explicit force
    s.ap = 10;
    expect(de).toBeTruthy();
    expect(doAction(s, fr, 'declare_war', es).ok).toBe(true);
    const o = interpret(s, 'attack Spain with 100k', null);
    expect(o.act?.id).toBe('attack');
    expect(o.act?.p).toEqual({ from: fr, amount: 100 });
    // moving troops between own lands
    const be = id('Belgium');
    s.countries[be].owner = fr; s.countries[be].status = 'annexed'; s.countries[be].troops = 1;
    const mv = interpret(s, 'deploy 20k troops to Belgium', null);
    expect(mv.act).toEqual({ id: 'move', tid: be, p: { from: fr, amount: 20 } });
  });
});

describe('Ollama aide (no server needed)', () => {
  it('parses model output, including fenced or chatty JSON and plain text', () => {
    expect(parseLlm('{"reply":"Yes, leader.","actions":[{"id":"propaganda","target":"Spain"}]}')).toEqual({ reply: 'Yes, leader.', actions: [{ id: 'propaganda', target: 'Spain' }] });
    expect(parseLlm('<think>hmm</think> Sure: {"reply":"ok","actions":[]} done').reply).toBe('ok');
    expect(parseLlm('I am just talking')).toEqual({ reply: 'I am just talking', actions: [] });
    expect(parseLlm('{"reply":"x","actions":[{"id":"a"},{"id":"b"},{"id":"c"},{"id":"d"}]}').actions.length).toBe(3);
  });
  it('maps model actions onto engine calls and rejects nonsense', () => {
    const s = game('France');
    const fr = id('France'), es = id('Spain');
    expect(resolveLlmAction(s, { id: 'propaganda', target: 'spain' }, null).act).toEqual({ id: 'propaganda', tid: es, p: {} });
    expect(resolveLlmAction(s, { id: 'law', law: 'tax_high' }, null).act).toEqual({ id: 'law', tid: fr, p: { law: 'tax_high' } });
    expect(resolveLlmAction(s, { id: 'tax_high' }, null).act).toEqual({ id: 'law', tid: fr, p: { law: 'tax_high' } });
    expect(resolveLlmAction(s, { id: 'Build Farm' }, null).act).toEqual({ id: 'build_farm', tid: fr, p: {} });
    expect(resolveLlmAction(s, { id: 'recruit', amount: 30 }, null).act).toEqual({ id: 'recruit', tid: fr, p: { amount: 30 } });
    expect(resolveLlmAction(s, { id: 'nuke', target: 'Spain' }, null).error).toContain('unknown action');
    expect(resolveLlmAction(s, { id: 'bribe', target: 'Atlantis' }, null).error).toContain('unknown country');
    expect(resolveLlmAction(s, { id: 'protests' }, es).act?.tid).toBe(es);
    const b = briefing(s, es);
    expect(b).toContain('I rule France');
    expect(b).toContain('SELECTED ON THE MAP: Spain');
  });
});

describe('AI scoring', () => {
  it('quickOdds grows with the size of the attacking force', () => {
    const s = game();
    const fr = s.countries[id('France')], be = s.countries[id('Belgium')];
    expect(quickOdds(s, fr, fr, be, 200)).toBeGreaterThan(quickOdds(s, fr, fr, be, 20));
  });
  it('war desire rises with grudges and hostility, and allies are not prey', () => {
    const s = game();
    const fr = id('France'), es = id('Spain');
    s.relations[relKey(fr, es)] = 0;
    const calm = warDesire(view(s, fr), s.countries[es]).u;
    s.countries[fr].memory.grudges[es] = 80;
    s.relations[relKey(fr, es)] = -70;
    expect(warDesire(view(s, fr), s.countries[es]).u).toBeGreaterThan(calm + 0.3);
    s.relations[relKey(fr, es)] = 80;
    s.countries[fr].memory.grudges[es] = 0;
    expect(warDesire(view(s, fr), s.countries[es]).u).toBeLessThan(calm);
  });
  it('a bot always deals with occupied land and attacks a helpless enemy', () => {
    const s = game();
    const fr = id('France'), be = id('Belgium');
    declareWar(s, fr, be);
    s.countries[be].allies = [];
    s.countries[be].troops = 0.5;
    const acts = decide(view(s, fr));
    expect(acts.some((a) => a.id === 'attack' && a.tid === be)).toBe(true);
    s.countries[be].owner = fr; s.countries[be].status = 'occupied';
    expect(decide(view(s, fr)).some((a) => (a.id === 'annex' || a.id === 'puppet') && a.tid === be)).toBe(true);
  });
  it('bots accept alliances from friends and refuse vassalage from equals', () => {
    const s = game();
    const fr = s.countries[id('France')], es = s.countries[id('Spain')];
    s.relations[relKey(fr.id, es.id)] = 90;
    es.allies = [];
    expect(acceptance(s, 'alliance', fr, es).ok).toBe(true);
    s.relations[relKey(fr.id, es.id)] = -50;
    expect(acceptance(s, 'alliance', fr, es).ok).toBe(false);
    expect(acceptance(s, 'vassal', fr, es).ok).toBe(false);
  });
  it('advisors and the threat radar produce explained recommendations', () => {
    const s = game('Iraq');
    const adv = advise(s);
    expect(adv.length).toBeGreaterThan(2);
    expect(adv.every((a) => a.title && a.why.length > 10)).toBe(true);
    expect(new Set(adv.map((a) => a.who)).size).toBeGreaterThan(1);
    const sa = id('Saudi Arabia');
    s.relations[relKey(id('Iraq'), sa)] = -90;
    s.countries[sa].memory.grudges[id('Iraq')] = 90;
    const th = threatRadar(s);
    expect(th[0].id).toBe(sa);
    expect(th[0].reasons.length).toBeGreaterThan(0);
  });
});

describe('determinism & turn loop', () => {
  it('the same seed replays the same world; another seed diverges', () => {
    const run = (seed: string) => {
      const s = game(null, seed);
      for (let i = 0; i < 12; i++) endTurn(s, runBots);
      return JSON.stringify({ c: s.countries, r: s.relations, n: s.news.length });
    };
    const a = run('alpha');
    expect(run('alpha')).toBe(a);
    expect(run('beta')).not.toBe(a);
  });
  it('a saved game (JSON round-trip) continues identically', () => {
    const s1 = game('France', 'save');
    for (let i = 0; i < 3; i++) endTurn(s1, runBots);
    const s2 = JSON.parse(JSON.stringify(s1)) as GameState;
    endTurn(s1, runBots);
    endTurn(s2, runBots);
    expect(JSON.stringify(s2.countries)).toBe(JSON.stringify(s1.countries));
  });
  it('advances the calendar, refills AP and keeps relations within bounds', () => {
    const s = game('France');
    s.ap = 0;
    const rep = endTurn(s, runBots);
    expect(s.turn).toBe(1);
    expect(s.ap).toBeGreaterThan(0);
    expect(rep.turn).toBe(0);
    expect(s.history.length).toBe(1);
    expect(Object.values(s.relations).every((v) => v >= -100 && v <= 100)).toBe(true);
    expect(rel(s, id('France'), id('France'))).toBe(100);
  });
});
