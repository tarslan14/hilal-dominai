// Nation life-cycle helpers: wars, death, restoration, conquest.
import { CONFIG } from './config';
import { chance, clamp } from './rng';
import { addGrudge, addNews, addRel, makeLeader, nations, rel, relKey, rootOf, setOwner, territoriesOf } from './state';
import type { Country, GameState } from './types';

export function isPlayer(s: GameState, id: string) {
  return s.playerId === id;
}

const drop = (arr: string[], id: string) => {
  const i = arr.indexOf(id);
  if (i >= 0) arr.splice(i, 1);
};

export function setWar(s: GameState, a: string, b: string) {
  if (a === b) return;
  const A = s.countries[a], B = s.countries[b];
  if (!A.alive || !B.alive || A.wars.includes(b)) return;
  A.wars.push(b);
  B.wars.push(a);
  drop(A.allies, b); drop(B.allies, a);
  drop(A.trade, b); drop(B.trade, a);
  delete A.pacts[b]; delete B.pacts[a];
  s.relations[relKey(a, b)] = Math.min(rel(s, a, b) - 50, -60);
}

export function endWar(s: GameState, a: string, b: string, truce = true) {
  const A = s.countries[a], B = s.countries[b];
  drop(A.wars, b);
  drop(B.wars, a);
  if (truce) {
    A.truces[b] = s.turn + CONFIG.diplomacy.truceTurns;
    B.truces[a] = s.turn + CONFIG.diplomacy.truceTurns;
  }
  addRel(s, a, b, 15);
}

/**
 * Declares war: root nations fight, puppets follow their overlords, allies of the defender may join.
 * Returns the list of nations that joined the defender.
 */
export function declareWar(s: GameState, attacker: string, defender: string): string[] {
  const a = rootOf(s, attacker), d = rootOf(s, defender);
  if (a === d) return [];
  const A = s.countries[a], D = s.countries[d];
  const O = CONFIG.overstretch;
  const brokePact = (A.pacts[d] ?? 0) > s.turn;
  const wasAlly = A.allies.includes(d);
  setWar(s, a, d);
  // justification: grudges or the defender's own infamy soften the reputation hit
  const just = clamp(((A.memory.grudges[d] ?? 0) + D.infamy) / 100, 0, 0.7);
  A.infamy += O.infamyWar * (1 - just) + (brokePact || wasAlly ? 12 : 0);
  if (brokePact || wasAlly) {
    D.memory.betrayedBy.push(a);
    for (const n of nations(s)) if (n.id !== a && n.id !== d) addRel(s, a, n.id, -8);
    addNews(s, 'diplo', `${A.name} tears up its treaty with ${D.name}. The world takes note of the betrayal.`, 3, [a, d]);
  }
  addGrudge(s, d, a, 40);
  addNews(s, 'war', `${A.name} declares war on ${D.name}!`, 3, [a, d]);
  s.fx.push({ kind: 'arc', from: a, to: d, color: '#ff3b4e' });
  // puppets follow
  for (const n of nations(s)) {
    if (n.overlord === a) setWar(s, n.id, d);
    if (n.overlord === d) setWar(s, n.id, a);
  }
  for (const n of nations(s)) {
    if (n.overlord === a) for (const m of nations(s)) if (m.overlord === d) setWar(s, n.id, m.id);
  }
  // allies of the defender are called in
  const joined: string[] = [];
  for (const allyId of D.allies.slice()) {
    const ally = s.countries[allyId];
    if (!ally.alive || ally.overlord || allyId === a || ally.wars.includes(a)) continue;
    if (A.allies.includes(allyId) && rel(s, allyId, a) >= rel(s, allyId, d)) continue; // torn ally stays out
    const p = CONFIG.diplomacy.allyJoinBase + (ally.leader.traits.loyalty - 0.5) * 0.6 + rel(s, allyId, d) / 300 - rel(s, allyId, a) / 300;
    if (isPlayer(s, allyId)) {
      // the player decides for themselves (prompted through a choice)
      s.choices.push({
        id: s.choiceSeq++, eventId: 'call_to_arms', title: 'Call to arms', targetId: d,
        text: `${A.name} has attacked your ally ${D.name}. They call on you to honour the alliance.`,
        options: [
          { label: 'Honour the alliance', desc: `Declare war on ${A.name}.`, effect: `joinwar:${a}:${d}` },
          { label: 'Stay out', desc: `Break your word: relations with ${D.name} collapse and the alliance ends.`, effect: `abandon:${d}` },
        ],
      });
      continue;
    }
    if (chance(s, clamp(p, 0.05, 0.95))) {
      drop(A.allies, allyId); drop(ally.allies, a);
      setWar(s, allyId, a);
      for (const n of nations(s)) if (n.overlord === allyId) setWar(s, n.id, a);
      joined.push(allyId);
      addNews(s, 'war', `${ally.name} honours its alliance and joins the war against ${A.name}.`, 2, [allyId, a, d]);
    } else {
      addRel(s, allyId, d, -25);
      drop(D.allies, allyId); drop(ally.allies, d);
      D.memory.betrayedBy.push(allyId);
      addNews(s, 'diplo', `${ally.name} abandons its ally ${D.name}.`, 2, [allyId, d]);
    }
  }
  return joined;
}

export function killNation(s: GameState, id: string, by: string | null) {
  const N = s.countries[id];
  if (!N.alive) return;
  N.alive = false;
  N.overlord = null;
  for (const n of s.ids.map((i) => s.countries[i])) {
    drop(n.wars, id); drop(n.allies, id); drop(n.trade, id); drop(n.sanctions, id);
    delete n.pacts[id]; delete n.truces[id];
    if (n.debt?.to === id) n.debt = null;
    if (n.overlord === id) {
      n.overlord = null;
      if (n.alive) addNews(s, 'diplo', `${n.name} is free of its fallen overlord ${N.name}.`, 2, [n.id]);
    }
  }
  N.wars = []; N.allies = []; N.trade = []; N.sanctions = []; N.pacts = {}; N.truces = {}; N.debt = null;
  if (s.coalition) {
    drop(s.coalition.members, id);
    if (s.coalition.target === id) s.coalition = null;
  }
  // remaining lands capitulate to the conqueror
  if (by) for (const t of territoriesOf(s, id)) {
    if (t.id === id) continue;
    setOwner(s, t.id, by, 'occupied');
    t.troops = Math.max(0.5, t.troops * 0.25);
    t.integration = 0;
    t.unrest = clamp(t.unrest + 15, 0, 100);
  }
  if (isPlayer(s, id) && !s.over) s.over = { won: false, reason: `${by ? s.countries[by].name : 'Your enemies'} captured your homeland.`, turn: s.turn };
}

/** Brings a dead nation back on its home territory (as a puppet of `overlord`, or independent). */
export function restoreNation(s: GameState, id: string, overlord: string | null) {
  const N = s.countries[id];
  N.alive = true;
  N.overlord = overlord;
  N.leader = makeLeader(s, N.government);
  N.laws = { tax: 0, conscription: false, martial: false, censorship: false };
  if (overlord) N.leader.traits.loyalty = clamp(N.leader.traits.loyalty + 0.3, 0, 1);
  N.wars = []; N.allies = []; N.trade = []; N.sanctions = []; N.pacts = {}; N.truces = {}; N.debt = null;
  N.influence = overlord ? { [overlord]: 60 } : {};
  N.spies = {};
  N.memory = { grudges: {}, betrayedBy: [], promises: {} };
  N.infamy = 0; N.warExhaustion = 0; N.brokeTurns = 0;
  N.treasury = N.gdp * CONFIG.eco.taxRate * 3;
  setOwner(s, id, id, 'home');
  N.integration = 100;
  N.unitCost = Math.max(CONFIG.eco.unitCostMin, (N.gdp * CONFIG.eco.taxRate * CONFIG.eco.startUpkeepShare) / Math.max(1, N.population * 3));
  if (overlord) {
    // inherit the overlord's wars
    for (const w of s.countries[overlord].wars) setWar(s, id, w);
    s.relations[relKey(id, overlord)] = 50;
  }
}

/** Territory `tid` falls to nation `attacker`. Handles capital capture / nation death. */
export function conquer(s: GameState, attacker: string, tid: string, garrison: number) {
  const T = s.countries[tid];
  const prev = T.owner;
  const prevN = s.countries[prev];
  setOwner(s, tid, attacker, 'occupied');
  T.troops = garrison;
  T.integration = 0;
  T.unrest = clamp(T.unrest + CONFIG.combat.occupationUnrest, 0, 100);
  T.stability = clamp(T.stability - 10, 0, 100);
  s.fx.push({ kind: 'conquer', to: tid });
  addGrudge(s, prev, attacker, 30);
  if (tid === prev) {
    addNews(s, 'war', `${prevN.name} has fallen! ${s.countries[attacker].name} occupies the capital.`, 3, [attacker, prev]);
    killNation(s, prev, attacker);
  } else {
    addNews(s, 'war', `${s.countries[attacker].name} seizes ${T.name} from ${prevN.name}.`, 2, [attacker, prev, tid]);
  }
}

/** Makes `id` a puppet of `overlord` (coup, vassalage). */
export function makePuppet(s: GameState, id: string, overlord: string) {
  const N = s.countries[id];
  // its own puppets are cut loose, old alliances lapse
  for (const n of nations(s)) if (n.overlord === id) n.overlord = null;
  for (const a of N.allies.slice()) { drop(s.countries[a].allies, id); }
  N.allies = [];
  for (const w of N.wars.slice()) endWar(s, id, w, false);
  N.overlord = overlord;
  N.influence[overlord] = Math.max(N.influence[overlord] ?? 0, 60);
  s.relations[relKey(id, overlord)] = Math.max(rel(s, id, overlord), 40);
  for (const w of s.countries[overlord].wars) setWar(s, id, w);
  if (s.coalition) drop(s.coalition.members, id);
}

export function ownerNation(s: GameState, territoryId: string): Country {
  return s.countries[s.countries[territoryId].owner];
}
