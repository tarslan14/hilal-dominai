// Random + conditional world events. Events that hit the player offer a choice with trade-offs;
// bots resolve the same events automatically.
import { applyProposal, type ProposalKind } from './actions';
import { CONFIG } from './config';
import { declareWar, isPlayer } from './nation';
import { chance, clamp, pick, rand, randInt } from './rng';
import { addGrudge, addNews, addRel, fmtMoney, links, nations, rel } from './state';
import { coupIn } from './tick';
import type { Country, GameState, PendingChoice } from './types';

const bump = (t: Country, unrest: number, stab: number, gdpMul = 1) => {
  t.unrest = clamp(t.unrest + unrest, 0, 100);
  t.stability = clamp(t.stability + stab, 0, 100);
  t.gdp *= gdpMul;
};
const months = (s: GameState, n: number) => Math.max(0.02, s.countries[s.playerId!].lastIncome * n);

function ask(s: GameState, c: Omit<PendingChoice, 'id'>) {
  s.choices.push({ id: s.choiceSeq++, ...c });
}

/** Picks a territory, biased toward the player's lands so events matter to them. */
function pickTerritory(s: GameState, filter: (t: Country) => boolean = () => true, weight: (t: Country) => number = () => 1): Country | null {
  const all = s.ids.map((i) => s.countries[i]).filter(filter);
  if (!all.length) return null;
  if (s.playerId && chance(s, CONFIG.events.playerBias)) {
    const mine = all.filter((t) => t.owner === s.playerId);
    if (mine.length) return pick(s, mine);
  }
  let total = 0;
  for (const t of all) total += weight(t);
  let r = rand(s) * total;
  for (const t of all) if ((r -= weight(t)) <= 0) return t;
  return all[all.length - 1];
}

interface EventDef {
  id: string;
  weight: (s: GameState) => number;
  fire: (s: GameState) => void;
}

const EVENTS: EventDef[] = [
  {
    id: 'famine', weight: () => 1.2,
    fire: (s) => {
      const t = pickTerritory(s, () => true, (c) => 11 - c.resources.food);
      if (!t) return;
      if (t.owner === s.playerId) {
        const cost = months(s, 1.5);
        ask(s, {
          eventId: 'famine', title: `Famine in ${t.name}`, targetId: t.id, text: `Harvests have failed in ${t.name}. Food prices explode and people are getting desperate.`,
          options: [
            { label: `Import food (${fmtMoney(cost)})`, desc: 'Unrest +3 only.', effect: `famine:import:${t.id}` },
            { label: 'Let them cope', desc: 'Unrest +14, stability -5, GDP -3%.', effect: `famine:cope:${t.id}` },
            { label: 'Blame a neighbour', desc: 'Unrest +7, but relations with a neighbour drop by 15.', effect: `famine:blame:${t.id}` },
          ],
        });
      } else bump(t, 12, -4, 0.97);
      addNews(s, 'event', `Famine strikes ${t.name}.`, t.owner === s.playerId ? 3 : 1, [t.id]);
    },
  },
  {
    id: 'crash', weight: (s) => (s.turn > 6 ? 0.5 : 0),
    fire: (s) => {
      for (const id of s.ids) {
        const t = s.countries[id];
        if (t.owner === s.playerId) continue;
        t.gdp *= 1 - (0.02 + 0.03 * Math.min(1, t.gdp / 2000));
        t.unrest = clamp(t.unrest + 3, 0, 100);
      }
      for (const n of nations(s)) if (n.id !== s.playerId && n.treasury > 0) n.treasury *= 0.9;
      addNews(s, 'event', 'Global financial crash! Markets collapse and treasuries shrink worldwide.', 3, []);
      if (s.playerId) {
        const cost = months(s, 2);
        ask(s, {
          eventId: 'crash', title: 'Global financial crash', targetId: s.playerId, text: 'Banks are failing around the world. Your finance minister wants instructions.',
          options: [
            { label: `Bail out the banks (${fmtMoney(cost)})`, desc: 'GDP -2%, stability holds.', effect: 'crash:bailout' },
            { label: 'Austerity', desc: 'GDP -4%, unrest +6, stability -5. Free.', effect: 'crash:austerity' },
          ],
        });
      }
    },
  },
  {
    id: 'pandemic', weight: (s) => (s.turn > 3 ? 0.6 : 0),
    fire: (s) => {
      const t = pickTerritory(s, (c) => c.population > 5, (c) => Math.sqrt(c.population));
      if (!t) return;
      const zone = [t, ...links(t).map((l) => s.countries[l])];
      let playerHit = false;
      for (const z of zone) {
        if (z.owner === s.playerId) playerHit = true;
        else bump(z, 6, -3, 0.96);
      }
      addNews(s, 'event', `A pandemic breaks out in ${t.name} and spreads to its neighbours.`, playerHit ? 3 : 2, zone.map((z) => z.id));
      if (playerHit) ask(s, {
        eventId: 'pandemic', title: 'Pandemic', targetId: t.id, text: `A new disease spreading from ${t.name} has reached your lands.`,
        options: [
          { label: 'Lockdown', desc: 'Affected lands: GDP -5%, unrest +3.', effect: `pandemic:lock:${t.id}` },
          { label: 'Stay open', desc: 'Affected lands: GDP -2%, unrest +10, stability -5.', effect: `pandemic:open:${t.id}` },
        ],
      });
    },
  },
  {
    id: 'revolution', weight: (s) => (s.ids.some((i) => s.countries[i].alive && i !== s.playerId && s.countries[i].unrest > 60) ? 1 : 0),
    fire: (s) => {
      const cands = nations(s).filter((n) => n.id !== s.playerId && n.unrest > 60);
      if (!cands.length) return;
      const n = cands.reduce((m, c) => (c.unrest > m.unrest ? c : m));
      addNews(s, 'event', `Revolution in ${n.name}! Crowds storm the government quarter.`, 2, [n.id]);
      coupIn(s, n.id, 'popular revolution');
    },
  },
  {
    id: 'nuclear', weight: (s) => (s.turn > 4 ? 0.4 : 0),
    fire: (s) => {
      const big = nations(s).filter((n) => n.tech >= 5 && n.troops > 100);
      let pair: [Country, Country] | null = null;
      let worst = -45;
      for (const a of big) for (const b of big) if (a.id < b.id && rel(s, a.id, b.id) < worst) { worst = rel(s, a.id, b.id); pair = [a, b]; }
      if (!pair) return;
      const [a, b] = pair;
      addRel(s, a.id, b.id, -10);
      for (const id of s.ids) s.countries[id].stability = clamp(s.countries[id].stability - 1.5, 0, 100);
      addNews(s, 'event', `Nuclear scare: ${a.name} and ${b.name} put their strategic forces on alert. The world holds its breath.`, 3, [a.id, b.id]);
      if (s.playerId && s.playerId !== a.id && s.playerId !== b.id) {
        const cost = months(s, 1);
        ask(s, {
          eventId: 'nuclear', title: 'Nuclear scare', targetId: a.id, text: `${a.name} and ${b.name} are one mistake away from catastrophe.`,
          options: [
            { label: `Mediate (${fmtMoney(cost)})`, desc: 'Relations +10 with both, your infamy -4.', effect: `nuclear:mediate:${a.id}:${b.id}` },
            { label: 'Stoke the fire', desc: 'Their relations -20 more. 35% chance you are exposed (relations -25 with both).', effect: `nuclear:stoke:${a.id}:${b.id}` },
            { label: 'Stay out of it', desc: 'No effect.', effect: 'none' },
          ],
        });
      }
    },
  },
  {
    id: 'disaster', weight: () => 1.2,
    fire: (s) => {
      const t = pickTerritory(s);
      if (!t) return;
      const kind = pick(s, ['An earthquake', 'A massive flood', 'A hurricane', 'A drought', 'Wildfires']);
      addNews(s, 'event', `${kind} devastates ${t.name}.`, t.owner === s.playerId ? 3 : 1, [t.id]);
      if (t.owner === s.playerId) {
        const cost = months(s, 1);
        ask(s, {
          eventId: 'disaster', title: `Disaster in ${t.name}`, targetId: t.id, text: `${kind} has hit ${t.name}. Infrastructure is wrecked.`,
          options: [
            { label: `Emergency relief (${fmtMoney(cost)})`, desc: 'GDP -3%, stability +3.', effect: `disaster:relief:${t.id}` },
            { label: 'Do nothing', desc: 'GDP -6%, unrest +10.', effect: `disaster:ignore:${t.id}` },
          ],
        });
      } else bump(t, 6, -2, 0.94);
    },
  },
  {
    id: 'scandal', weight: () => 1,
    fire: (s) => {
      const list = nations(s);
      const n = s.playerId && chance(s, CONFIG.events.playerBias) ? s.countries[s.playerId] : pick(s, list);
      if (!n.alive) return;
      addNews(s, 'event', `Corruption scandal rocks the government of ${n.name}.`, isPlayer(s, n.id) ? 3 : 1, [n.id]);
      if (isPlayer(s, n.id)) {
        const cost = months(s, 0.7);
        ask(s, {
          eventId: 'scandal', title: 'Scandal', targetId: n.id, text: 'Leaked documents implicate one of your ministers in massive corruption.',
          options: [
            { label: `Cover it up (${fmtMoney(cost)})`, desc: '60%: nothing happens. 40%: it backfires, stability -14.', effect: 'scandal:cover' },
            { label: 'Sack the minister', desc: 'Stability -4.', effect: 'scandal:sack' },
          ],
        });
      } else bump(n, 4, -8);
    },
  },
  {
    id: 'un', weight: (s) => (nations(s).some((n) => n.infamy > 25) ? 1.3 : 0),
    fire: (s) => {
      const n = nations(s).reduce((m, c) => (c.infamy > m.infamy ? c : m));
      if (n.infamy <= 25) return;
      addNews(s, 'event', `UN resolution condemns the aggression of ${n.name}.`, isPlayer(s, n.id) ? 3 : 2, [n.id]);
      if (isPlayer(s, n.id)) {
        ask(s, {
          eventId: 'un', title: 'UN resolution', targetId: n.id, text: 'The General Assembly demands that you halt your expansion and pay reparations.',
          options: [
            { label: `Comply (${fmtMoney(months(s, 1))})`, desc: 'Infamy -12, stability -2.', effect: 'un:comply' },
            { label: 'Defy the world', desc: 'Several powers sanction you. Infamy +3.', effect: 'un:defy' },
          ],
        });
      } else if (chance(s, 0.4)) {
        n.infamy = Math.max(0, n.infamy - 10);
        n.treasury -= Math.max(0, n.lastIncome);
      } else unSanctions(s, n.id);
    },
  },
  {
    id: 'arms', weight: () => 0.8,
    fire: (s) => {
      const cands = nations(s).filter((n) => n.neighbors.some((m) => s.countries[m].alive && s.countries[m].owner === m && rel(s, n.id, m) < -25));
      if (!cands.length) return;
      const a = s.playerId && cands.some((c) => c.id === s.playerId) && chance(s, 0.4) ? s.countries[s.playerId] : pick(s, cands);
      const rivals = a.neighbors.map((m) => s.countries[m]).filter((m) => m.alive && m.owner === m.id && rel(s, a.id, m.id) < -25);
      const b = pick(s, rivals);
      addRel(s, a.id, b.id, -8);
      addNews(s, 'event', `Arms race: ${a.name} and ${b.name} are rearming at breakneck speed.`, isPlayer(s, a.id) || isPlayer(s, b.id) ? 3 : 1, [a.id, b.id]);
      for (const n of [a, b]) {
        if (isPlayer(s, n.id)) {
          const other = n === a ? b : a;
          const cost = n.troops * 0.08 * n.unitCost * CONFIG.eco.recruitMonths;
          ask(s, {
            eventId: 'arms', title: 'Arms race', targetId: other.id, text: `${other.name} is expanding its army by 10%. Your generals demand a response.`,
            options: [
              { label: `Match them (${fmtMoney(cost)})`, desc: 'Home troops +8%.', effect: 'arms:match' },
              { label: 'Hold back', desc: 'Stability +2. They gain the edge.', effect: 'arms:hold' },
            ],
          });
        } else n.troops *= 1.1;
      }
    },
  },
];

function unSanctions(s: GameState, target: string) {
  const T = s.countries[target];
  const pool = nations(s).filter((n) => n.id !== target && !n.overlord && !n.allies.includes(target) && !n.sanctions.includes(target) && n.id !== s.playerId)
    .sort((a, b) => b.gdp - a.gdp).slice(0, 14);
  let k = 0;
  for (const n of pool) {
    if (k >= 5) break;
    if (!chance(s, 0.6)) continue;
    n.sanctions.push(target);
    if (n.trade.includes(target)) { n.trade.splice(n.trade.indexOf(target), 1); T.trade.splice(T.trade.indexOf(n.id), 1); }
    addRel(s, n.id, target, -10);
    k++;
  }
  if (k) addNews(s, 'econ', `${k} powers impose sanctions on ${T.name} after the UN vote.`, isPlayer(s, target) ? 3 : 1, [target]);
}

export function rollEvents(s: GameState) {
  const n = chance(s, CONFIG.events.perTurnChance) ? (chance(s, 0.2) ? 2 : 1) : 0;
  for (let i = 0; i < n; i++) {
    let total = 0;
    const ws = EVENTS.map((e) => { const w = e.weight(s); total += w; return w; });
    let r = rand(s) * total;
    for (let k = 0; k < EVENTS.length; k++) {
      if ((r -= ws[k]) <= 0) { EVENTS[k].fire(s); break; }
    }
  }
}

/** Applies the player's answer to a pending choice. Returns a short result text. */
export function resolveChoice(s: GameState, choiceId: number, optionIdx: number): string {
  const i = s.choices.findIndex((c) => c.id === choiceId);
  if (i < 0) return '';
  const ch = s.choices[i];
  s.choices.splice(i, 1);
  const opt = ch.options[optionIdx] ?? ch.options[ch.options.length - 1];
  const [a, b, c, d] = opt.effect.split(':');
  const me = s.countries[s.playerId!];
  const t = s.countries[c] ?? me;
  const pay = (n: number) => (me.treasury -= months(s, n));
  const mine = (zoneOf: Country) => [zoneOf, ...links(zoneOf).map((l) => s.countries[l])].filter((z) => z.owner === me.id);
  switch (a) {
    case 'accept': applyProposal(s, b as ProposalKind, c, me.id); return 'Accepted.';
    case 'refuse':
      addRel(s, me.id, c, b === 'vassal' ? -25 : -5);
      if (b === 'vassal') addGrudge(s, c, me.id, 25);
      return 'Refused.';
    case 'joinwar': declareWar(s, me.id, b); addRel(s, me.id, c, 20); return `You stand by ${s.countries[c].name}.`;
    case 'abandon': {
      const D = s.countries[b];
      addRel(s, me.id, b, -40);
      me.allies = me.allies.filter((x) => x !== b);
      D.allies = D.allies.filter((x) => x !== me.id);
      D.memory.betrayedBy.push(me.id);
      me.infamy += 4;
      return `You abandon ${D.name}.`;
    }
    case 'famine':
      if (b === 'import') { pay(1.5); bump(t, 3, 0); return 'Food convoys arrive in time.'; }
      if (b === 'cope') { bump(t, 14, -5, 0.97); return 'The famine runs its course.'; }
      {
        const ns = t.neighbors.map((n) => s.countries[n].owner).filter((o) => o !== me.id);
        bump(t, 7, -2, 0.98);
        if (ns.length) { const o = pick(s, ns); addRel(s, me.id, o, -15); return `The press blames ${s.countries[o].name}.`; }
        return 'There is nobody to blame.';
      }
    case 'crash':
      for (const z of s.ids.map((x) => s.countries[x]).filter((z) => z.owner === me.id)) b === 'bailout' ? bump(z, 0, 0, 0.98) : bump(z, 6, -5, 0.96);
      if (b === 'bailout') pay(2);
      return b === 'bailout' ? 'The banks survive.' : 'Austerity bites.';
    case 'pandemic':
      for (const z of mine(t)) b === 'lock' ? bump(z, 3, 0, 0.95) : bump(z, 10, -5, 0.98);
      return b === 'lock' ? 'Lockdowns contain the outbreak.' : 'Life goes on, at a price.';
    case 'nuclear': {
      const A = s.countries[c], B = s.countries[d];
      if (b === 'mediate') { pay(1); addRel(s, me.id, A.id, 10); addRel(s, me.id, B.id, 10); addRel(s, A.id, B.id, 10); me.infamy = Math.max(0, me.infamy - 4); return 'Your mediation cools tempers.'; }
      addRel(s, A.id, B.id, -20);
      if (chance(s, 0.35)) { addRel(s, me.id, A.id, -25); addRel(s, me.id, B.id, -25); me.infamy += 4; addNews(s, 'covert', `${me.name} is caught fanning the nuclear crisis.`, 3, [me.id]); return 'Your meddling is exposed!'; }
      return 'The crisis deepens, and nobody suspects you.';
    }
    case 'disaster':
      if (b === 'relief') { pay(1); bump(t, 0, 3, 0.97); return 'Relief reaches the victims.'; }
      bump(t, 10, -2, 0.94);
      return 'The victims are left to fend for themselves.';
    case 'scandal':
      if (b === 'sack') { bump(me, 0, -4); return 'The minister is sacrificed.'; }
      pay(0.7);
      if (chance(s, 0.4)) { bump(me, 6, -14); return 'The cover-up leaks. The public is furious.'; }
      return 'The story dies quietly.';
    case 'un':
      if (b === 'comply') { pay(1); me.infamy = Math.max(0, me.infamy - 12); bump(me, 0, -2); return 'You bow to the resolution.'; }
      me.infamy += 3;
      unSanctions(s, me.id);
      return 'You defy the world.';
    case 'arms':
      if (b === 'match') { me.treasury -= me.troops * 0.08 * me.unitCost * CONFIG.eco.recruitMonths; me.troops *= 1.08; return 'Your army grows.'; }
      bump(me, 0, 2);
      return 'You keep your powder dry.';
  }
  return '';
}

export const _eventIds = EVENTS.map((e) => e.id);
export { randInt };
