// Command board interpreter: turns a typed order ("deploy 50k troops to Syria", "raise taxes",
// "run propaganda in Iran") into a game action. Rule-based and fully offline: no model, no network.
import { launchPoints, type Params } from '../engine/actions';
import { links, territoriesOf } from '../engine/state';
import type { Country, GameState } from '../engine/types';

export interface Order {
  ok: boolean;
  say: string; // what the aide understood (or why not)
  act?: { id: string; tid: string; p: Params };
  endTurn?: boolean;
}

const ALIASES: Record<string, string[]> = {
  'United States': ['usa', 'u.s.a', 'u.s.', 'us', 'america', 'the states'],
  'United Kingdom': ['uk', 'u.k.', 'britain', 'great britain', 'england'],
  'United Arab Emirates': ['uae', 'emirates'],
  'DR Congo': ['drc', 'democratic republic of congo', 'congo-kinshasa'],
  'Turkey': ['turkiye', 'türkiye'],
  'Russia': ['russian federation'],
  'South Korea': ['s. korea', 'rok'],
  'North Korea': ['n. korea', 'dprk'],
  'Czechia': ['czech republic'],
  'Bosnia & Herzegovina': ['bosnia'],
  'North Macedonia': ['macedonia'],
  "Côte d'Ivoire": ['ivory coast', 'cote d\'ivoire'],
  'Myanmar': ['burma'],
  'Netherlands': ['holland'],
};

const escRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Finds every country mentioned in the text, in order of appearance. */
function findCountries(s: GameState, text: string): { c: Country; at: number; len: number }[] {
  const hits: { c: Country; at: number; len: number }[] = [];
  const names: [string, Country][] = [];
  for (const id of s.ids) {
    const c = s.countries[id];
    names.push([c.name.toLowerCase(), c]);
    for (const a of ALIASES[c.name] ?? []) names.push([a, c]);
  }
  names.sort((a, b) => b[0].length - a[0].length);
  const taken: boolean[] = [];
  for (const [n, c] of names) {
    const re = new RegExp(`(^|[^a-z])(${escRe(n)})(?![a-z])`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const at = m.index + m[1].length;
      let free = true;
      for (let i = at; i < at + n.length; i++) if (taken[i]) free = false;
      if (!free) continue;
      for (let i = at; i < at + n.length; i++) taken[i] = true;
      hits.push({ c, at, len: n.length });
    }
  }
  return hits.sort((a, b) => a.at - b.at);
}

/** Resolves a single country name or alias (as typed by a person or a model). */
export function findCountry(s: GameState, name: string): Country | undefined {
  const n = name.toLowerCase().trim();
  for (const id of s.ids) if (s.countries[id].name.toLowerCase() === n) return s.countries[id];
  return findCountries(s, ' ' + n + ' ')[0]?.c;
}

/** "50k", "1.2m", "200 thousand", "40%", "half", "all" -> troops in thousands (or a share of `pool`). */
function parseAmount(text: string, pool: number): number | undefined {
  if (/\ball\b|\beverything\b|\bentire\b/.test(text)) return pool;
  if (/\bhalf\b/.test(text)) return pool / 2;
  if (/\bquarter\b/.test(text)) return pool / 4;
  const pc = text.match(/(\d+(?:\.\d+)?)\s*%/);
  if (pc) return (pool * Math.min(100, Number(pc[1]))) / 100;
  const m = text.match(/(\d+(?:[.,]\d+)?)\s*(k|thousand|m|million)?\b/);
  if (!m) return undefined;
  const v = Number(m[1].replace(',', '.'));
  const u = m[2];
  if (u === 'm' || u === 'million') return v * 1000;
  if (u === 'k' || u === 'thousand') return v;
  return v >= 1000 ? v / 1000 : v; // bare numbers: 50000 -> 50k, 50 -> 50k
}

interface Rule {
  re: RegExp;
  id: string;
  where: 'foreign' | 'own' | 'any';
  label: string;
  law?: string;
}

// Order matters: the first matching rule wins.
const RULES: Rule[] = [
  { re: /\b(lower|cut|reduce|low)\b.*\btax/, id: 'law', law: 'tax_low', where: 'own', label: 'lower taxes' },
  { re: /\b(raise|increase|hike|high|higher)\b.*\btax/, id: 'law', law: 'tax_high', where: 'own', label: 'raise taxes' },
  { re: /\b(normal|restore|reset|standard)\b.*\btax/, id: 'law', law: 'tax_normal', where: 'own', label: 'set normal taxes' },
  { re: /\bconscript|\bdraft\b|\bmandatory service/, id: 'law', law: 'conscription', where: 'own', label: 'toggle conscription' },
  { re: /\bmartial law|\bcurfew|state of emergency/, id: 'law', law: 'martial', where: 'own', label: 'toggle martial law' },
  { re: /\bcensor|\bfree press|\bpress freedom|\bmedia law/, id: 'law', law: 'censorship', where: 'own', label: 'toggle press censorship' },
  { re: /\bfarm|\bagricultur|\bfood|\bharvest|\birrigat/, id: 'build_farm', where: 'own', label: 'develop agriculture' },
  { re: /\bbarrack|\bfortif|\bfortress|\bmilitary (base|development|infrastructure)|\barsenal/, id: 'build_barracks', where: 'own', label: 'build barracks' },
  { re: /\bindustr|\bfactor|\bmarket|\binvest|\beconom(y|ic)|\binfrastructure|\bgrow(th)?\b/, id: 'build_industry', where: 'own', label: 'build industry' },
  { re: /\bresearch|\btech(nology)?\b|\bmoderni[sz]e/, id: 'research', where: 'own', label: 'fund military research' },
  { re: /\bpeace\b|\bceasefire|\barmistice/, id: 'peace', where: 'foreign', label: 'sue for peace' },
  { re: /\bdeclare war|\bgo to war|\bwar (on|with|against)/, id: 'declare_war', where: 'foreign', label: 'declare war' },
  { re: /\binvade|\battack|\bassault|\bstrike\b(?!s)|\bconquer|\bstorm\b/, id: 'attack', where: 'foreign', label: 'attack' },
  { re: /\bdeploy|\bmove\b|\bsend\b.*\b(troops|army|soldiers|forces)|\bstation|\breinforce|\bredeploy|\btransfer\b.*\b(troops|army)/, id: 'move', where: 'any', label: 'deploy troops' },
  { re: /\brecruit|\braise\b.*\b(troops|army|soldiers)|\btrain\b|\bmobili[sz]e|\benlist/, id: 'recruit', where: 'own', label: 'recruit troops' },
  { re: /\bpropagand/, id: 'propaganda', where: 'foreign', label: 'run propaganda' },
  { re: /\bbribe|\bcorrupt|\bpay off/, id: 'bribe', where: 'foreign', label: 'bribe officials' },
  { re: /\bopposition|\bdissident/, id: 'fund_opposition', where: 'foreign', label: 'fund the opposition' },
  { re: /\belection|\brig\b|\bvote\b/, id: 'election', where: 'foreign', label: 'interfere in the election' },
  { re: /\bcoup|\boverthrow|\btopple|\bregime change/, id: 'coup', where: 'foreign', label: 'sponsor a coup' },
  { re: /\bassassinat|\beliminate|\bkill\b/, id: 'assassinate', where: 'foreign', label: 'assassinate a minister' },
  { re: /\bcyber|\bhack/, id: 'cyber', where: 'foreign', label: 'launch a cyberattack' },
  { re: /\bsabotag|\bblow up|\bdestroy infrastructure/, id: 'sabotage', where: 'foreign', label: 'sabotage infrastructure' },
  { re: /\bmisinform|\brumou?r|\bfake news/, id: 'misinfo', where: 'foreign', label: 'spread misinformation' },
  { re: /\bdisinform|\bforge|\bleak/, id: 'disinfo', where: 'foreign', label: 'run disinformation' },
  { re: /\bprotest|\briot|\bunrest|\bdemonstration|\bdestabili[sz]e/, id: 'protests', where: 'foreign', label: 'incite protests' },
  { re: /\bstrikes?\b|\bwalkout/, id: 'strikes', where: 'foreign', label: 'organize strikes' },
  { re: /\brefugee/, id: 'refugees', where: 'foreign', label: 'engineer a refugee crisis' },
  { re: /\bspy|\bspies|\bintelligence|\bagents?\b|\binfiltrat|\bespionage/, id: 'spy', where: 'foreign', label: 'build a spy network' },
  { re: /\b(break|end|leave|cancel)\b.*\ballianc/, id: 'break_alliance', where: 'foreign', label: 'break the alliance' },
  { re: /\ballianc|\bally\b/, id: 'alliance', where: 'foreign', label: 'propose an alliance' },
  { re: /\b(lift|remove|end|drop)\b.*\bsanction/, id: 'lift_sanction', where: 'foreign', label: 'lift sanctions' },
  { re: /\bsanction|\bembargo/, id: 'sanction', where: 'foreign', label: 'impose sanctions' },
  { re: /\btrade|\bcommerce/, id: 'trade', where: 'foreign', label: 'propose a trade deal' },
  { re: /\bnon.?aggression|\btreaty|\bpact\b/, id: 'pact', where: 'foreign', label: 'propose a non-aggression treaty' },
  { re: /\bloan|\blend|\bdebt/, id: 'debt_trap', where: 'foreign', label: 'offer a debt-trap loan' },
  { re: /\bvassal|\bsubmit|\bultimatum|\bsubjugat/, id: 'vassalize', where: 'foreign', label: 'demand vassalage' },
  { re: /\bpuppet/, id: 'puppet', where: 'own', label: 'install a puppet government' },
  { re: /\bannex|\babsorb/, id: 'annex', where: 'any', label: 'annex' },
  { re: /\bliberate|\brelease|\bfree\b|\bindependence/, id: 'release', where: 'own', label: 'liberate' },
  { re: /\bcrack ?down|\bsuppress|\bpolice|\bcrush/, id: 'suppress', where: 'own', label: 'crack down' },
  { re: /\breform|\baid\b|\bwelfare|\bstabili[sz]e|\bcalm/, id: 'reform', where: 'own', label: 'pass reforms' },
  { re: /\bdiploma|\bmission|\brelations|\benvoy|\bambassador|\bbefriend/, id: 'diplomacy', where: 'foreign', label: 'send a diplomatic mission' },
];

export const COMMAND_EXAMPLES = [
  'Deploy 50k troops to the border with Syria',
  'Run a propaganda campaign in Iran',
  'Raise taxes',
  'Build farms',
  'Introduce conscription',
  'Invade Kuwait',
  'Propose a trade deal with Turkey',
  'Incite protests in Saudi Arabia',
];

export function interpret(s: GameState, raw: string, selected: string | null): Order {
  const text = ' ' + raw.toLowerCase().replace(/\s+/g, ' ').trim() + ' ';
  if (!s.playerId) return { ok: false, say: 'There is no government to command yet.' };
  if (text.trim().length < 2) return { ok: false, say: 'Give me an order, leader.' };
  const me = s.countries[s.playerId];
  if (/\b(end|next|finish|pass)\b.*\b(turn|month)\b|\bend turn\b/.test(text)) return { ok: true, say: 'Ending the month.', endTurn: true };

  const rule = RULES.find((r) => r.re.test(text));
  if (!rule) return { ok: false, say: 'I did not understand that order. Try: deploy troops, recruit, attack, propaganda, protests, trade deal, alliance, build farms / barracks / industry, raise taxes, conscription, martial law.' };

  const found = findCountries(s, text);
  const fromIdx = text.search(/\bfrom\b/);
  let source: Country | undefined;
  let targets = found;
  if (fromIdx >= 0) {
    const after = found.find((f) => f.at > fromIdx);
    if (after) { source = after.c; targets = found.filter((f) => f !== after); }
  }
  const mine = territoriesOf(s, me.id);
  const sel = selected ? s.countries[selected] : undefined;
  let target: Country | undefined = targets[0]?.c;

  // ---- laws and research: nation-wide
  if (rule.id === 'law') return { ok: true, say: `Understood: ${rule.label}.`, act: { id: 'law', tid: me.id, p: { law: rule.law } } };
  if (rule.id === 'research') return { ok: true, say: 'Understood: fund military research.', act: { id: 'research', tid: me.id, p: {} } };

  // ---- annex: an occupied land of mine, or one of my puppets
  if (rule.id === 'annex') {
    target ??= sel;
    if (!target) return { ok: false, say: 'Annex which land?' };
    if (target.owner === me.id) return { ok: true, say: `Understood: annex ${target.name}.`, act: { id: 'annex', tid: target.id, p: {} } };
    return { ok: true, say: `Understood: absorb the puppet ${target.name}.`, act: { id: 'absorb', tid: target.id, p: {} } };
  }

  // ---- troop movement
  if (rule.id === 'move') {
    target ??= sel;
    if (!target) return { ok: false, say: 'Deploy troops where? Name a country or select one on the globe.' };
    if (target.owner !== me.id) {
      // "to the border with X": mass on my land that touches X
      const border = mine.filter((t) => links(t).some((l) => s.countries[l].owner === target!.owner)).sort((a, b) => a.troops - b.troops)[0];
      if (!border) return { ok: false, say: `You hold no land next to ${target.name}.` };
      const from = source ?? mine.filter((t) => t.id !== border.id).sort((a, b) => b.troops - a.troops)[0];
      if (!from || from.owner !== me.id) return { ok: false, say: `${border.name} is your only land near ${target.name}; your troops are already there. Recruit more or attack.` };
      const amount = Math.min(from.troops, parseAmount(text, from.troops) ?? from.troops * 0.5);
      return { ok: true, say: `Understood: move ${amount.toFixed(0)}k from ${from.name} to ${border.name}, on the border with ${target.name}.`, act: { id: 'move', tid: border.id, p: { from: from.id, amount } } };
    }
    const from = source ?? mine.filter((t) => t.id !== target!.id).sort((a, b) => b.troops - a.troops)[0];
    if (!from || from.owner !== me.id || from.id === target.id) return { ok: false, say: 'You have no other land to move troops from.' };
    const amount = Math.min(from.troops, parseAmount(text, from.troops) ?? from.troops * 0.5);
    return { ok: true, say: `Understood: move ${amount.toFixed(0)}k from ${from.name} to ${target.name}.`, act: { id: 'move', tid: target.id, p: { from: from.id, amount } } };
  }

  // ---- attack / invade
  if (rule.id === 'attack') {
    target ??= sel && sel.owner !== me.id ? sel : undefined;
    if (!target || target.owner === me.id) return { ok: false, say: 'Attack whom? Name a foreign country.' };
    if (!me.wars.includes(target.owner)) return { ok: true, say: `You are not at war with ${s.countries[target.owner].name}. Declaring war first; order the attack again afterwards.`, act: { id: 'declare_war', tid: target.id, p: {} } };
    const pts = launchPoints(s, me.id, target.id).filter((c) => c.troops > 0.2);
    const from = (source && pts.find((c) => c.id === source!.id)) || pts.sort((a, b) => b.troops - a.troops)[0];
    if (!from) return { ok: false, say: `No troops in a land next to ${target.name}. Deploy some to the border first.` };
    const amount = Math.min(from.troops, parseAmount(text, from.troops) ?? from.troops * 0.8);
    return { ok: true, say: `Understood: attack ${target.name} with ${amount.toFixed(0)}k from ${from.name}.`, act: { id: 'attack', tid: target.id, p: { from: from.id, amount } } };
  }

  // ---- everything else: resolve the land the order applies to
  if (rule.where === 'own') {
    if (!target || target.owner !== me.id) target = sel && sel.owner === me.id ? sel : s.countries[me.id].owner === me.id ? s.countries[me.id] : mine[0];
    const p: Params = {};
    if (rule.id === 'recruit') { const n = parseAmount(text, 0); if (n) p.amount = n; }
    return { ok: true, say: `Understood: ${rule.label} in ${target.name}.`, act: { id: rule.id, tid: target.id, p } };
  }
  target ??= sel && sel.owner !== me.id ? sel : undefined;
  if (!target || target.owner === me.id) return { ok: false, say: `To ${rule.label} I need a foreign country. Name one or select it on the globe.` };
  return { ok: true, say: `Understood: ${rule.label} ${rule.id === 'declare_war' ? 'on' : rule.id === 'peace' || rule.id === 'trade' || rule.id === 'alliance' || rule.id === 'pact' ? 'with' : 'in'} ${target.name}.`, act: { id: rule.id, tid: target.id, p: {} } };
}
