// Optional local-LLM aide for the command board. Talks to an Ollama server on this machine
// (default http://localhost:11434): nothing leaves the computer and no API key is involved.
// The model chats and proposes actions as JSON; every action still goes through doAction(),
// so the model can never do anything the rules do not allow. If Ollama is unreachable the
// board falls back to the offline keyword parser in command.ts.
import { ACTIONS, LAWS, type Params } from '../engine/actions';
import { budgetOf } from '../engine/economy';
import { computePowers, dateOf, fmtMoney, fmtTroops, links, rel, rootOf, territoriesOf } from '../engine/state';
import type { GameState } from '../engine/types';
import { threatRadar } from './advisor';
import { findCountry, interpret } from './command';

export interface OllamaConfig {
  enabled: boolean;
  url: string;
  model: string;
}
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}
export interface LlmAction {
  id: string;
  target?: string;
  from?: string;
  amount?: number; // thousands of troops
  law?: string;
}
export interface LlmReply {
  reply: string;
  actions: LlmAction[];
}

const KEY = 'dominai.ollama';
export const DEFAULT_OLLAMA: OllamaConfig = { enabled: false, url: 'http://localhost:11434', model: '' };

export function loadOllamaConfig(): OllamaConfig & { saved: boolean } {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_OLLAMA, ...JSON.parse(raw), saved: true };
  } catch { /* ignore */ }
  return { ...DEFAULT_OLLAMA, saved: false };
}
export function saveOllamaConfig(c: OllamaConfig) {
  localStorage.setItem(KEY, JSON.stringify({ enabled: c.enabled, url: c.url, model: c.model }));
}

/** Lists the models installed on the Ollama server, or throws if it cannot be reached. */
export async function ollamaModels(url: string): Promise<string[]> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 4000);
  try {
    const r = await fetch(url.replace(/\/+$/, '') + '/api/tags', { signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = (await r.json()) as { models?: { name: string }[] };
    return (j.models ?? []).map((m) => m.name);
  } finally {
    clearTimeout(t);
  }
}

const ACTION_HELP: Record<string, string> = {
  diplomacy: 'improve relations', propaganda: 'raise my influence there', bribe: 'buy influence', fund_opposition: 'raise their unrest',
  election: 'install a friendly government (democracies)', coup: 'make them my puppet (needs influence 45+ or their stability <= 30)',
  alliance: 'propose alliance', break_alliance: 'end alliance', pact: 'non-aggression treaty', trade: 'trade deal', sanction: 'sanction them',
  lift_sanction: 'lift sanctions', debt_trap: 'lend money for influence', vassalize: 'demand they become my puppet (needs 4x their army)',
  absorb: 'annex my own puppet', peace: 'end the war', spy: 'build spy network', sabotage: 'damage their GDP', disinfo: 'turn them against a friend',
  assassinate: 'kill a minister', cyber: 'drain treasury, disrupt army', protests: 'unrest +10', strikes: 'GDP down, unrest up',
  refugees: 'unrest via refugees', misinfo: 'make chaos spread faster', declare_war: 'declare war (2 AP)', attack: 'attack a land of a nation I am at war with (amount, from optional)',
  recruit: 'raise troops in my land (amount optional)', move: 'move my troops to my land `target` (from, amount optional; free)', annex: 'annex a land I occupy',
  puppet: 'turn a land I occupy into a puppet state', release: 'liberate a land I hold', build_farm: 'agriculture: stability, manpower',
  build_barracks: 'military: cheaper recruits, defence', build_industry: 'economy: income, growth', research: 'military tech +0.25',
  suppress: 'crack down on unrest in my land', reform: 'calm my land (costly)', law: 'change a law, set `law`',
};

/** Compact briefing of the situation, written for the model. */
export function briefing(s: GameState, selected: string | null): string {
  const me = s.countries[s.playerId!];
  const powers = computePowers(s);
  const b = budgetOf(s, me.id);
  const lands = territoriesOf(s, me.id);
  const L = me.laws;
  const lines: string[] = [];
  lines.push(`DATE ${dateOf(s.turn)}. I rule ${me.name}. Action points left this month: ${s.ap}. Treasury ${fmtMoney(me.treasury)} (net ${fmtMoney(b.net)}/month). Home stability ${me.stability.toFixed(0)}/100, infamy ${me.infamy.toFixed(0)}, tech ${me.tech.toFixed(1)}. Empire share ${((powers[me.id]?.share ?? 0) * 100).toFixed(1)}% (win at 60%), world rank #${powers[me.id]?.rank}.`);
  lines.push(`LAWS: taxes ${['low', 'normal', 'high'][L.tax + 1]}, conscription ${L.conscription ? 'on' : 'off'}, martial law ${L.martial ? 'on' : 'off'}, censorship ${L.censorship ? 'on' : 'off'}.`);
  lines.push('MY LANDS: ' + lands.slice(0, 14).map((t) => `${t.name} (${t.status}, ${fmtTroops(t.troops)} troops, unrest ${t.unrest.toFixed(0)}, farms ${t.buildings.farm}, barracks ${t.buildings.barracks}, industry ${t.buildings.industry})`).join('; '));
  if (me.wars.length) lines.push('AT WAR WITH: ' + me.wars.map((w) => s.countries[w].name).join(', '));
  if (me.allies.length) lines.push('ALLIES: ' + me.allies.map((w) => s.countries[w].name).join(', '));
  const seen = new Set<string>();
  const nb: string[] = [];
  for (const t of lands) for (const l of links(t)) {
    const o = s.countries[l];
    if (o.owner === me.id || seen.has(o.id)) continue;
    seen.add(o.id);
    const N = s.countries[o.owner];
    const status = me.wars.includes(N.id) ? 'AT WAR' : me.allies.includes(N.id) ? 'ally' : N.overlord === me.id ? 'my puppet' : `relations ${rel(s, me.id, N.id).toFixed(0)}`;
    nb.push(`${o.name}${o.owner !== o.id ? ' (held by ' + N.name + ')' : ''}: ${fmtTroops(o.troops)} troops, tech ${N.tech.toFixed(0)}, stability ${o.stability.toFixed(0)}, unrest ${o.unrest.toFixed(0)}, my influence ${(s.countries[rootOf(s, N.id)].influence[me.id] ?? 0).toFixed(0)}, ${status}`);
  }
  lines.push('LANDS BORDERING MINE: ' + nb.slice(0, 16).join('; '));
  const th = threatRadar(s, powers).slice(0, 3);
  if (th.length) lines.push('TOP THREATS: ' + th.map((t) => `${s.countries[t.id].name} (${t.atWar ? 'at war' : Math.round(t.score * 100) + '%'}: ${t.reasons[0]})`).join('; '));
  if (selected) lines.push(`SELECTED ON THE MAP: ${s.countries[selected].name} (orders without a country refer to it).`);
  return lines.join('\n');
}

const SYSTEM = `You are the chief aide of the player's government in the strategy game dominAI. You talk with the leader (the player) and carry out their orders.
Answer ONLY with a JSON object: {"reply": string, "actions": array}.
- "reply": 1-3 short sentences, in character, in the language the leader uses. Give honest advice from the briefing when asked. Never invent numbers.
- "actions": the game actions to execute NOW, in order. Use [] when the leader is only chatting or asking a question, or when the order is unclear (then ask in "reply"). Maximum 3.
Each action: {"id": one of the ids below, "target": country name exactly as in the briefing (omit for law/research), "from": my land the troops come from (optional), "amount": thousands of troops (optional), "law": law id (only for id "law")}.
A direct order ("do X", "put taxes up", "attack Y") IS the approval: put the actions in "actions" immediately and never ask "are you sure"; you may mention a downside in "reply" while doing it. Only leave "actions" empty for questions, small talk, or orders you truly cannot map to an action id. Most actions cost 1 action point; do not plan more than the points left.
ACTION IDS:
${ACTIONS.map((a) => `${a.id} [${a.scope === 'own' ? 'my land' : 'foreign'}]: ${ACTION_HELP[a.id] ?? a.name}`).join('\n')}
LAW IDS: ${LAWS.map((l) => l.id).join(', ')} (conscription, martial, censorship toggle on/off).`;

const SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, target: { type: 'string' }, from: { type: 'string' }, amount: { type: 'number' }, law: { type: 'string' } },
        required: ['id'],
      },
    },
  },
  required: ['reply', 'actions'],
};

export function parseLlm(content: string): LlmReply {
  const txt = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  try {
    const a = txt.indexOf('{'), b = txt.lastIndexOf('}');
    const j = JSON.parse(a >= 0 && b > a ? txt.slice(a, b + 1) : txt);
    const actions = Array.isArray(j.actions) ? j.actions.filter((x: unknown) => x && typeof (x as LlmAction).id === 'string').slice(0, 3) : [];
    return { reply: String(j.reply ?? '').trim() || '...', actions };
  } catch {
    return { reply: txt || '...', actions: [] };
  }
}

export async function askOllama(cfg: OllamaConfig, s: GameState, selected: string | null, history: ChatTurn[], text: string): Promise<LlmReply> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 120000);
  try {
    const r = await fetch(cfg.url.replace(/\/+$/, '') + '/api/chat', {
      method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model, stream: false, think: false, format: SCHEMA, keep_alive: '15m', options: { temperature: 0.3, num_ctx: 8192 },
        messages: [{ role: 'system', content: SYSTEM }, ...history.slice(-8), { role: 'user', content: `BRIEFING\n${briefing(s, selected)}\n\nTHE LEADER SAYS: ${text}` }],
      }),
    });
    if (!r.ok) throw new Error(`Ollama answered HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
    const j = (await r.json()) as { message?: { content?: string } };
    return parseLlm(j.message?.content ?? '');
  } finally {
    clearTimeout(t);
  }
}

/** Turns one model-proposed action into an engine call, or explains why it cannot. Pure. */
export function resolveLlmAction(s: GameState, a: LlmAction, selected: string | null): { act?: { id: string; tid: string; p: Params }; error?: string } {
  const me = s.countries[s.playerId!];
  // be forgiving about how the model spells things: "tax_high" as an action, "Build Farm", "law:martial" ...
  a = { ...a, id: String(a.id).toLowerCase().trim().replace(/[\s-]+/g, '_') };
  if (a.id.startsWith('law:')) a = { ...a, id: 'law', law: a.id.slice(4) };
  if (LAWS.some((l) => l.id === a.id)) a = { ...a, law: a.id, id: 'law' };
  const def = ACTIONS.find((x) => x.id === a.id);
  if (!def) return { error: `unknown action "${a.id}"` };
  if (a.id === 'law') {
    if (!LAWS.some((l) => l.id === a.law)) return { error: `unknown law "${a.law ?? ''}"` };
    return { act: { id: 'law', tid: me.id, p: { law: a.law } } };
  }
  if (a.id === 'research') return { act: { id: 'research', tid: me.id, p: {} } };
  const T = a.target ? findCountry(s, a.target) : selected ? s.countries[selected] : undefined;
  if (a.target && !T) return { error: `unknown country "${a.target}"` };
  if (a.id === 'attack' || a.id === 'move') {
    // reuse the offline resolver for launch points, borders and default amounts
    if (!T) return { error: 'no target given' };
    const amt = a.amount && a.amount > 0 ? `${a.amount}k ` : '';
    const from = a.from && findCountry(s, a.from) ? ` from ${findCountry(s, a.from)!.name}` : '';
    const o = interpret(s, a.id === 'attack' ? `attack ${T.name} with ${amt}${from}` : `deploy ${amt}troops to ${T.name}${from}`, null);
    return o.act ? { act: o.act } : { error: o.say };
  }
  let land = T;
  if (def.scope === 'own' && (!land || land.owner !== me.id)) land = s.countries[me.id].owner === me.id ? s.countries[me.id] : territoriesOf(s, me.id)[0];
  if (!land) return { error: 'no target given' };
  const p: Params = {};
  if (a.id === 'recruit' && a.amount && a.amount > 0) p.amount = a.amount;
  return { act: { id: a.id, tid: land.id, p } };
}
