import { advise, PERSONAS, threatRadar, type Advice } from '../ai/advisor';
import { runBots } from '../ai/bot';
import { worldSeeds } from '../data/seeds';
import { loadWorld } from '../data/world';
import { COMMAND_EXAMPLES, interpret } from '../ai/command';
import { askOllama, loadOllamaConfig, ollamaModels, resolveLlmAction, saveOllamaConfig, type ChatTurn } from '../ai/ollama';
import { BUILDINGS, doAction, launchPoints, LAWS, listActions, previewAttack, recruitUnitCost, viewAction, type ActionView, type Cat, type Params } from '../engine/actions';
import { CONFIG, type Difficulty } from '../engine/config';
import { budgetOf, manpowerCap } from '../engine/economy';
import { resolveChoice } from '../engine/events';
import { allied, apMax, computePowers, createGame, dateOf, fmtMoney, fmtTroops, GOV_LABEL, links, nations, puppetsOf, rel, territoriesOf, type PowerInfo } from '../engine/state';
import { garrisonRatio, overstretchOf } from '../engine/tick';
import { endTurn, type TurnReport } from '../engine/turn';
import type { CombatResult, Country, GameState, NewsItem } from '../engine/types';
import { colorFor, MAP_MODES, nationColor, type MapMode } from '../render/colors';
import { Globe } from '../render/globe';
import { css, type RGB } from '../render/painter';
import { drawTerrain, type TerrainMark } from '../render/terrain';
import { avatarSvg } from './avatar';
import { clearSave, hasSave, loadGame, saveGame } from './save';
import { isMuted, setMuted, sfx } from './sound';

const $ = (id: string) => document.getElementById(id)!;
const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const pct = (v: number) => `${Math.round(v * 100)}%`;
const n0 = (v: number) => v.toFixed(0);

// ---------- tiny delegated-event registry ----------
class Handlers {
  map = new Map<string, (el: HTMLElement) => void>();
  private n = 0;
  constructor(private prefix: string) {}
  on(fn: (el: HTMLElement) => void): string {
    const id = this.prefix + this.n++;
    this.map.set(id, fn);
    return `data-on="${id}"`;
  }
  input(fn: (el: HTMLElement) => void): string {
    const id = this.prefix + this.n++;
    this.map.set(id, fn);
    return `data-in="${id}"`;
  }
  clear() { this.map.clear(); }
}
const P = new Handlers('p');
const M = new Handlers('m');
const find = (id?: string) => (id ? P.map.get(id) ?? M.map.get(id) : undefined);
document.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-on]');
  if (el && !(el as HTMLButtonElement).disabled) find(el.dataset.on)?.(el);
});
document.addEventListener('input', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-in]');
  if (el) find(el.dataset.in)?.(el);
});

// ---------- app state ----------
const world = loadWorld();
const seeds = worldSeeds(world);
let globe: Globe;
let S: GameState;
let phase: 'start' | 'play' | 'over' = 'start';
let sel: string | null = null;
let mode: MapMode = 'political';
type LeftTab = 'overview' | 'develop' | 'actions';
let leftTab: LeftTab = 'overview';
let rightTab: 'command' | 'advisors' | 'threats' | 'log' = 'command';
let cmdDraft = '';
let cmdLog: { q: string; say: string; res?: string; ok: boolean }[] = [];
const ollama = loadOllamaConfig();
let ollamaModelsFound: string[] | null = null; // null = server not reachable
let aideBusy = false;
let chat: ChatTurn[] = [];
let actTab: Cat = 'political';
let startDiff: Difficulty = 'normal';
let startSeed = Math.random().toString(36).slice(2, 8);
let replayTimer = 0;
const painted = new Map<string, RGB>();

const me = () => S.countries[S.playerId!];
const involvesMe = (n: NewsItem) => !!S.playerId && n.ids.some((id) => id === S.playerId || S.countries[id]?.owner === S.playerId);
const visible = (n: NewsItem) => n.importance >= 2 || involvesMe(n);

export function boot() {
  globe = new Globe($('globe'), world);
  globe.onHover = hover;
  globe.onClick = (id) => select(id);
  window.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return;
    if (e.key === 'Escape') { if ($('overlay').dataset.dismiss === '1') closeModal(); return; }
    if ($('overlay').classList.contains('on') && !$('overlay').classList.contains('clear')) return;
    const i = '123456'.indexOf(e.key);
    if (i >= 0) setMode(MAP_MODES[i].id);
    if (e.key === 't' || e.key === 'T') openTerrain();
    if (phase === 'play' && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); endTurnClick(); }
  });
  renderModes();
  startScreen();
  void probeOllama(true);
  // the desktop launcher starts Ollama alongside the game: look again while it warms up
  for (const ms of [4000, 12000, 30000]) setTimeout(() => { if (ollamaModelsFound === null) void probeOllama(true); }, ms);
}

// ---------- painting / fx ----------
function repaint(conquered: Set<string> = new Set()) {
  for (const c of world.countries) {
    const col = colorFor(S, mode, c.id);
    const old = painted.get(c.id);
    if (conquered.has(c.id) && old && (old[0] !== col[0] || old[1] !== col[1] || old[2] !== col[2])) globe.fade(c.id, old, col);
    else globe.painter.paint(c.id, col);
    painted.set(c.id, col);
  }
}

function drainFx(): Set<string> {
  const conquered = new Set<string>();
  let arcs = 0;
  const mine = (id?: string) => !!id && !!S.playerId && (id === S.playerId || S.countries[id]?.owner === S.playerId);
  for (const f of S.fx.splice(0)) {
    if (f.kind === 'conquer') conquered.add(f.to);
    else if (f.kind === 'pulse') { if (arcs < 30) globe.pulse(f.to, f.color); }
    else if (f.kind === 'arc' && f.from) {
      const war = f.color === '#ff3b4e';
      // covert arcs are only drawn for the player's own operations (no fog-of-war leaks)
      if (mine(f.from) || (war && (mine(f.to) || arcs < 10))) { globe.arc(f.from, f.to, f.color); arcs++; }
    }
  }
  return conquered;
}

function updateMarkers() {
  const fronts: string[] = [];
  const pid = S.playerId;
  for (const id of S.ids) {
    const t = S.countries[id];
    const owner = S.countries[t.owner];
    if (!owner.wars.length) continue;
    if (links(t).some((l) => owner.wars.includes(S.countries[l].owner))) {
      if (pid && (t.owner === pid || owner.wars.includes(pid))) fronts.unshift(id);
      else fronts.push(id);
    }
  }
  globe.setFronts(fronts);
  globe.setUnrest(S.ids.map((id) => S.countries[id]).filter((t) => t.unrest > 60).map((t) => ({ id: t.id, level: Math.min(1, (t.unrest - 55) / 40) })));
}

function setMode(m: MapMode) {
  mode = m;
  renderModes();
  repaint();
}

function renderModes() {
  $('modes').innerHTML = MAP_MODES.map((m, i) => `<button class="mode ${m.id === mode ? 'on' : ''}" title="${m.hint} [${i + 1}]" data-mode="${m.id}">${m.label}</button>`).join('');
  $('modes').insertAdjacentHTML('beforeend', '<div class="hints"><span>Rotate<kbd>Drag</kbd></span><span>Zoom<kbd>Scroll</kbd></span><span>Select<kbd>Click</kbd></span><span>End turn<kbd>Space</kbd></span></div>');
  $('modes').insertAdjacentHTML('beforeend', '<button class="mode" id="terrain-btn" title="Relief map of the selected country [T]">Terrain</button>');
  $('terrain-btn').onclick = () => { sfx.click(); openTerrain(); };
  $('modes').querySelectorAll<HTMLElement>('.mode[data-mode]').forEach((b) => (b.onclick = () => { sfx.click(); setMode(b.dataset.mode as MapMode); }));
}

function hover(id: string | null, x: number, y: number) {
  const tip = $('tooltip');
  if (!id) return void (tip.style.display = 'none');
  const c = S.countries[id];
  const owner = S.countries[c.owner];
  let extra = '';
  if (c.owner !== id) extra += ` · held by ${esc(owner.name)}`;
  if (S.playerId && c.owner !== S.playerId) extra += `<br>relations ${n0(rel(S, S.playerId, c.owner))}${me().wars.includes(c.owner) ? ' · <span class="bad">AT WAR</span>' : ''}`;
  tip.style.display = 'block';
  tip.style.left = Math.min(window.innerWidth - 270, x + 14) + 'px';
  tip.style.top = y + 14 + 'px';
  tip.innerHTML = `<b>${esc(c.name)}</b><small>GDP ${fmtMoney(c.gdp)} · ${fmtTroops(c.troops)} troops · stab ${n0(c.stability)} · unrest ${n0(c.unrest)}${extra}</small>`;
}

function select(id: string | null, fly = true) {
  if (phase === 'over') return;
  sel = id;
  globe.select(id);
  if (id) { sfx.select(); if (fly) globe.flyTo(id); }
  if (phase === 'start') return startScreen(false);
  refresh();
}

function toast(msg: string, kind: 'good' | 'bad' | '' = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 4200);
  while ($('toasts').children.length > 4) $('toasts').firstElementChild!.remove();
}

// ---------- modal plumbing ----------
function openModal(html: string, opts: { clear?: boolean; dismiss?: boolean } = {}) {
  const o = $('overlay');
  o.className = 'on' + (opts.clear ? ' clear' : '');
  o.dataset.dismiss = opts.dismiss ? '1' : '0';
  o.innerHTML = html;
}
function closeModal() {
  const o = $('overlay');
  o.className = '';
  o.innerHTML = '';
  M.clear();
}

// =====================================================================================
// START SCREEN
// =====================================================================================
function difficultyRating(s: GameState, id: string, powers: Record<string, PowerInfo>): { label: string; cls: string; why: string } {
  const c = s.countries[id];
  const p = powers[id];
  let score = p.rank <= 5 ? 0 : p.rank <= 20 ? 1 : p.rank <= 60 ? 2 : 3;
  let big: Country | null = null;
  for (const l of links(c)) {
    const o = s.countries[l];
    if (rel(s, id, l) < -20 && (powers[l]?.mil ?? 0) > p.mil * 2 && (!big || powers[l].mil > powers[big.id].mil)) big = o;
  }
  if (big) score++;
  if (c.stability < 35) score++;
  const labels = ['Easy', 'Moderate', 'Hard', 'Very hard', 'Brutal', 'Suicidal'];
  const cls = ['good', 'good', 'warn', 'bad', 'bad', 'bad'];
  const why = [`world power #${p.rank}`, big ? `hostile ${big.name} next door` : '', c.stability < 35 ? 'unstable at home' : ''].filter(Boolean).join(', ');
  return { label: labels[Math.min(5, score)], cls: cls[Math.min(5, score)], why };
}

function startScreen(rebuild = true) {
  phase = 'start';
  if (rebuild) {
    S = createGame(seeds, { seed: startSeed, playerId: null, difficulty: startDiff });
    painted.clear();
    repaint();
    globe.setFronts([]);
    globe.setUnrest([]);
    globe.autoRotate = !sel;
  }
  $('topbar').style.display = 'none';
  $('left').innerHTML = '';
  $('right').innerHTML = '';
  $('ticker').style.display = 'none';
  M.clear();
  const powers = computePowers(S);
  let body = `<p class="muted">Pick a country on the globe. Drag to rotate, scroll to zoom.</p>`;
  if (sel) {
    const c = S.countries[sel];
    const p = powers[sel];
    const d = difficultyRating(S, sel, powers);
    const nb = links(c).map((l) => S.countries[l]);
    body = `
      <div class="h1"><span class="chip" style="background:${css(nationColor(S, sel))}"></span>${esc(c.name)}</div>
      <div class="leader">${avatarSvg(c.leader, c.government)}<div><b>${esc(c.leader.title)} ${esc(c.leader.name)}</b><br><span class="muted">${GOV_LABEL[c.government]} · you replace this leader</span></div></div>
      <div class="grid2">
        ${kv('GDP', fmtMoney(c.gdp))}${kv('Population', c.population >= 1 ? c.population.toFixed(1) + 'M' : (c.population * 1000).toFixed(0) + 'k')}
        ${kv('Military', fmtTroops(c.troops))}${kv('Tech level', c.tech.toFixed(1))}
        ${kv('Stability', n0(c.stability))}${kv('World power', '#' + p.rank)}
        ${kv('Monthly budget', fmtMoney(c.gdp * CONFIG.eco.taxRate))}${kv('Empire share', (p.share * 100).toFixed(1) + '%')}
      </div>
      <div class="kv"><span>Start difficulty</span><span class="${d.cls}">${d.label}</span></div>
      <div class="muted" style="font-size:11px;margin:2px 0 8px">${esc(d.why)}</div>
      <div class="sect">Neighbours (${nb.length})</div>
      <div style="max-height:150px;overflow:auto">${nb.map((o) => `<div class="list-row" ${M.on(() => select(o.id))}><span class="chip" style="background:${css(nationColor(S, o.id))}"></span><span class="grow">${esc(o.name)}${c.seaLinks.includes(o.id) ? ' <span class="muted">(sea)</span>' : ''}</span><span class="mono ${rel(S, c.id, o.id) < -20 ? 'bad' : rel(S, c.id, o.id) > 20 ? 'good' : 'muted'}">${n0(rel(S, c.id, o.id))}</span><span class="mono muted">${fmtTroops(o.troops)}</span></div>`).join('') || '<span class="muted">Island nation: reachable by sea only.</span>'}</div>`;
  }
  const diffs: Difficulty[] = ['easy', 'normal', 'hard', 'brutal'];
  openModal(`<div class="modal start-panel">
    <div class="modal-body" style="flex:1">
      <h1 class="hero">domin<b>AI</b></h1>
      <p class="muted" style="margin-top:2px">Turn one nation into a world empire. Every other country is run by an AI leader with its own agenda.</p>
      ${body}
    </div>
    <div class="modal-body" style="border-top:1px solid var(--line)">
      <div class="field"><label>Difficulty</label><div class="seg">${diffs.map((d) => `<button class="btn small ${d === startDiff ? 'on' : ''}" ${M.on(() => { startDiff = d; sfx.click(); startScreen(false); })}>${d}</button>`).join('')}</div></div>
      <div class="field"><label>World seed (same seed = same world)</label><input type="text" id="seed" value="${esc(startSeed)}" maxlength="24"></div>
      <div style="display:flex;gap:8px">
        <button class="btn primary" style="flex:1" ${sel ? '' : 'disabled'} ${M.on(() => beginGame())}>${sel ? 'Rule ' + esc(S.countries[sel].name) : 'Select a country'}</button>
        ${hasSave() ? `<button class="btn" ${M.on(() => continueGame())}>Continue</button>` : ''}
      </div>
    </div></div>`, { clear: true });
  const seedEl = $('seed') as HTMLInputElement;
  seedEl.onchange = () => { startSeed = seedEl.value.trim() || 'dominai'; startScreen(true); };
}

function kv(k: string, v: string, cls = '') {
  return `<div class="kv"><span>${k}</span><span class="${cls}">${v}</span></div>`;
}

function beginGame() {
  if (!sel) return;
  S = createGame(seeds, { seed: startSeed, playerId: sel, difficulty: startDiff });
  enterPlay();
  S.news.push({ turn: 0, kind: 'system', text: `${me().name} has a new leader. The world is watching.`, importance: 2, ids: [sel] });
  saveGame(S);
  refresh();
  if (localStorage.getItem('dominai.tutorial') !== 'done') tutorial(0);
}

function continueGame() {
  const g = loadGame();
  if (!g) return toast('No valid save found', 'bad');
  S = g;
  sel = S.playerId;
  enterPlay();
  refresh();
  if (S.over) endScreen();
}

function enterPlay() {
  phase = 'play';
  cmdLog = [];
  chat = [];
  cmdDraft = '';
  leftTab = 'overview';
  closeModal();
  clearInterval(replayTimer);
  $('topbar').style.display = '';
  $('ticker').style.display = '';
  painted.clear();
  globe.autoRotate = false;
  globe.select(sel);
  if (sel) globe.flyTo(sel);
  sfx.ok();
}

// =====================================================================================
// MAIN HUD
// =====================================================================================
function refresh() {
  if (phase === 'start') return;
  P.clear();
  const conquered = drainFx();
  repaint(conquered);
  updateMarkers();
  const powers = computePowers(S);
  renderTop(powers);
  renderLeft(powers);
  renderRight(powers);
  renderTicker();
}

function renderTop(powers: Record<string, PowerInfo>) {
  const m = me();
  const p = powers[m.id];
  const b = m.alive ? budgetOf(S, m.id) : null;
  const max = apMax(S);
  const pips = Array.from({ length: max }, (_, i) => `<i class="pip ${i < S.ap ? 'on' : ''}"></i>`).join('');
  const share = p?.share ?? 0;
  $('topbar').innerHTML = `
    <div class="logo">domin<b>AI</b></div>
    <div class="stat"><small>Date</small><span>${dateOf(S.turn)} <span class="muted">T${S.turn + 1}</span></span></div>
    <div class="stat" title="Action Points: spent on actions, refilled every month. A bigger empire has more."><small>Action points</small><span><span class="pips">${pips}</span> ${S.ap}</span></div>
    <div class="stat" title="Income ${b ? fmtMoney(b.gross) : ''}, upkeep ${b ? fmtMoney(b.upkeep) : ''}, tribute ${b ? fmtMoney(b.tribute) : ''}"><small>Treasury</small><span class="${m.treasury < 0 ? 'bad' : ''}">${fmtMoney(m.treasury)} <span class="${b && b.net < 0 ? 'bad' : 'good'}">${b ? (b.net >= 0 ? '+' : '') + fmtMoney(b.net) : ''}</span></span></div>
    <div class="stat"><small>Army</small><span>${fmtTroops(p?.troops ?? 0)}</span></div>
    <div class="stat" title="Home stability. At ${CONFIG.stab.playerCoupStability} you are overthrown."><small>Stability</small><span class="${m.stability < 30 ? 'bad' : m.stability < 50 ? 'warn' : 'good'}">${n0(m.stability)}</span></div>
    <div class="stat" title="Your reputation as an aggressor. Around ${CONFIG.coalition.minInfamy} the world unites against you."><small>Infamy</small><span class="${m.infamy > 30 ? 'bad' : m.infamy > 15 ? 'warn' : ''}">${n0(m.infamy)}</span></div>
    <div class="stat" title="Your bloc's share of world GDP + military (incl. puppets). Reach ${pct(CONFIG.win.share)} to win."><small>Empire share · win at ${pct(CONFIG.win.share)}</small><span style="display:flex;align-items:center;gap:8px"><span class="sharebar"><i style="width:${Math.min(100, share * 100)}%"></i><u style="left:${CONFIG.win.share * 100}%"></u></span>${(share * 100).toFixed(1)}%</span></div>
    <div class="stat"><small>World rank</small><span>#${p?.rank ?? '-'}<span class="muted"> / ${nations(S).length}</span></span></div>
    <span class="spacer"></span>
    <button class="btn" ${P.on(() => leaderboard())}>Leaderboard</button>
    <button class="btn icon" title="Sound on/off" ${P.on(() => { setMuted(!isMuted()); sfx.click(); refresh(); })}>${isMuted() ? 'Sound off' : 'Sound on'}</button>
    <button class="btn icon" ${P.on(() => menu())}>Menu</button>
    <button class="btn primary" id="endturn" title="[Space]" ${P.on(() => endTurnClick())}>END TURN</button>`;
}

function bar(v: number, color: string) {
  return `<div class="bar"><i style="width:${Math.max(0, Math.min(100, v))}%;background:${color}"></i></div>`;
}

function renderLeft(powers: Record<string, PowerInfo>) {
  const left = $('left');
  const keep = left.querySelector('.panel-body')?.scrollTop ?? 0;
  const m = me();
  if (!sel) {
    // empire overview
    const lands = territoriesOf(S, m.id);
    const pups = puppetsOf(S, m.id);
    const os = overstretchOf(lands);
    left.innerHTML = `<div class="ptitle">Your Empire</div><div class="orn">◆</div>
      <div class="panel-head"><span class="muted">Select a country on the globe to act.</span></div>
      <div class="panel-body">
      <div class="grid2">${kv('Lands', String(lands.length))}${kv('Puppets', String(pups.length))}${kv('Overstretch', os.toFixed(1), os > 1 ? 'warn' : '')}${kv('War exhaustion', n0(m.warExhaustion), m.warExhaustion > 40 ? 'bad' : '')}</div>
      <div class="sect">Lands</div>${lands.map((t) => landRow(t)).join('')}
      ${pups.length ? `<div class="sect">Puppets</div>${pups.map((t) => landRow(t)).join('')}` : ''}
      ${m.wars.length ? `<div class="sect">At war with</div>${m.wars.map((w) => landRow(S.countries[w])).join('')}` : ''}
      ${m.allies.length ? `<div class="sect">Allies</div>${m.allies.map((w) => landRow(S.countries[w])).join('')}` : ''}
      </div>`;
    return;
  }
  const T = S.countries[sel];
  const N = S.countries[T.owner];
  const own = T.owner === m.id;
  const isHome = T.id === N.id;
  const tags: string[] = [];
  if (own) tags.push(`<span class="tag">${T.status === 'home' ? 'Your homeland' : T.status === 'occupied' ? 'Occupied by you' : 'Annexed ' + n0(T.integration) + '%'}</span>`);
  else {
    if (!isHome) tags.push(`<span class="tag warn">${T.status} by ${esc(N.name)}</span>`);
    if (N.overlord === m.id) tags.push('<span class="tag violet">Your puppet</span>');
    else if (N.overlord) tags.push(`<span class="tag violet">Puppet of ${esc(S.countries[N.overlord].name)}</span>`);
    if (m.wars.includes(N.id)) tags.push('<span class="tag bad">At war</span>');
    if (m.allies.includes(N.id)) tags.push('<span class="tag good">Ally</span>');
    if (m.trade.includes(N.id)) tags.push('<span class="tag good">Trade</span>');
    if ((m.pacts[N.id] ?? 0) > S.turn) tags.push('<span class="tag">Treaty</span>');
    if ((m.truces[N.id] ?? 0) > S.turn) tags.push('<span class="tag">Truce</span>');
    if (m.sanctions.includes(N.id)) tags.push('<span class="tag warn">You sanction</span>');
    if (N.sanctions.includes(m.id)) tags.push('<span class="tag bad">Sanctions you</span>');
    if (S.coalition?.target === m.id && S.coalition.members.includes(N.id)) tags.push('<span class="tag bad">Coalition</span>');
    if (N.debt?.to === m.id) tags.push('<span class="tag violet">In your debt</span>');
  }
  const tabsFor: LeftTab[] = own ? ['overview', 'develop', 'actions'] : ['overview', 'actions'];
  if (!tabsFor.includes(leftTab)) leftTab = 'overview';
  const tabLabel: Record<LeftTab, string> = { overview: 'Overview', develop: 'Develop', actions: 'Actions' };
  const lv = (n: number) => `<span class="lv">${Array.from({ length: CONFIG.build.max }, (_, i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('')}</span>`;
  let body = '';

  if (leftTab === 'overview') {
    const r = rel(S, m.id, N.id);
    const inf = N.influence[m.id] ?? 0;
    const spy = N.spies[m.id] ?? 0;
    const tr = N.leader.traits;
    const trait = (k: string, v: number) => `<div>${k}${bar(v * 100, 'var(--muted)')}</div>`;
    const pw = powers[N.id];
    let detail = '';
    if (own) {
      const b = budgetOf(S, m.id);
      const cap = manpowerCap(territoriesOf(S, m.id), m.laws.conscription);
      detail = `<div class="sect">Empire budget / month</div><div class="grid2">${kv('Tax income', fmtMoney(b.gross), 'good')}${kv('Army upkeep', '-' + fmtMoney(b.upkeep), 'bad')}${kv('Tribute', fmtMoney(b.tribute))}${kv('Interest', fmtMoney(b.interest))}${kv('Net', fmtMoney(b.net), b.net < 0 ? 'bad' : 'good')}${kv('Manpower', `${fmtTroops(pw?.troops ?? 0)} / ${fmtTroops(cap)}`)}</div>
        ${T.status !== 'home' ? kv('Garrison', pct(garrisonRatio(T)) + ' of need', garrisonRatio(T) < 0.6 ? 'warn' : 'good') : ''}`;
    } else {
      detail = `<div class="sect">Your standing</div>
        <div class="kv"><span>Relations</span><span class="${r < -20 ? 'bad' : r > 20 ? 'good' : ''}">${n0(r)}</span></div>${bar((r + 100) / 2, r < 0 ? 'var(--bad)' : 'var(--good)')}
        <div class="kv" style="margin-top:4px"><span>Your influence</span><span class="acc">${n0(inf)}</span></div>${bar(inf, 'var(--violet)')}
        <div class="grid2">${kv('Spy network', `${spy}/${CONFIG.covert.spyMax}`)}${kv('Their grudge', n0(N.memory.grudges[m.id] ?? 0), (N.memory.grudges[m.id] ?? 0) > 30 ? 'bad' : '')}${kv('Treasury', spy > 0 ? fmtMoney(N.treasury) : 'needs spies')}${kv('World power', pw ? '#' + pw.rank : '-')}</div>
        ${N.wars.length ? `<div class="kv"><span>At war with</span><span>${N.wars.slice(0, 3).map((w) => esc(S.countries[w].name)).join(', ')}${N.wars.length > 3 ? '…' : ''}</span></div>` : ''}
        ${N.allies.length ? `<div class="kv"><span>Allies</span><span>${N.allies.slice(0, 3).map((w) => esc(S.countries[w].name)).join(', ')}${N.allies.length > 3 ? '…' : ''}</span></div>` : ''}`;
    }
    body = `
      <div class="leader">${avatarSvg(N.leader, N.government)}<div style="flex:1"><b>${own ? 'You' : esc(N.leader.title + ' ' + N.leader.name)}</b><br><span class="muted">${esc(N.name)} · ${GOV_LABEL[N.government]}${own ? '' : ' · goal: ' + N.leader.goal}</span>
        ${own ? '' : `<div class="traits" style="margin-top:4px">${trait('Aggression', tr.aggression)}${trait('Paranoia', tr.paranoia)}${trait('Ambition', tr.ambition)}${trait('Diplomacy', tr.diplomacy)}${trait('Greed', tr.greed)}${trait('Loyalty', tr.loyalty)}</div>`}</div></div>
      <div class="grid2">
        ${kv('GDP', fmtMoney(T.gdp))}${kv('Population', T.population >= 1 ? T.population.toFixed(1) + 'M' : (T.population * 1000).toFixed(0) + 'k')}
        ${kv('Troops here', fmtTroops(T.troops))}${kv('Tech', N.tech.toFixed(1))}
        ${kv('Stability', n0(T.stability), T.stability < 30 ? 'bad' : T.stability < 50 ? 'warn' : 'good')}${kv('Unrest', n0(T.unrest), T.unrest > 60 ? 'bad' : T.unrest > CONFIG.chaos.threshold ? 'warn' : '')}
        ${kv('Oil / Food', `${T.resources.oil} / ${T.resources.food}`)}${kv('Terrain', T.terrain ? 'Rough' : 'Open')}
      </div>
      ${T.unrest > CONFIG.chaos.threshold ? '<div class="warn" style="font-size:11.5px">Unrest is contagious: it is spreading to neighbours.</div>' : ''}
      <div class="sect">Development</div>
      ${BUILDINGS.map((b) => `<div class="kv"><span>${b.name} <span class="muted">· ${b.branch}</span></span><span>${lv(T.buildings[b.id])}</span></div>`).join('')}
      ${detail}`;
  } else if (leftTab === 'develop') {
    const blds = BUILDINGS.map((b) => {
      const v = viewAction(S, m.id, 'build_' + b.id, T.id);
      return `<div class="bld"><h4>${b.name}<small>${b.branch}</small><span class="spacer"></span>${lv(T.buildings[b.id])}</h4><p>${esc(b.effect)}</p>
        <div class="row"><span class="muted">${v.reason && T.buildings[b.id] >= CONFIG.build.max ? 'Maximum level' : fmtMoney(v.cost) + ' · 1 AP'}</span><span class="spacer"></span><button class="btn small" ${v.reason ? `disabled title="${esc(v.reason)}"` : ''} ${P.on(() => runAction('build_' + b.id, T.id, {}))}>Build level ${Math.min(CONFIG.build.max, T.buildings[b.id] + 1)}</button></div></div>`;
    }).join('');
    const groups = [...new Set(LAWS.map((l) => l.group))];
    const laws = groups.map((g) => `<div class="kv" style="border:none"><span>${g}</span><span></span></div><div class="laws">${LAWS.filter((l) => l.group === g).map((l) => {
      const on = l.active(m.laws);
      const locked = (on && l.tax !== undefined) || S.ap < 1;
      return `<button class="law ${on ? 'on' : ''}" ${locked ? 'disabled' : ''} title="${esc(l.effect)}${on && l.tax === undefined ? ' Click to repeal.' : ''}" ${P.on(() => runAction('law', m.id, { law: l.id }))}>${l.name}</button>`;
    }).join('')}</div>`).join('');
    const decrees = listActions(S, m.id, sel).filter((a) => a.cat === 'domestic').map((a) => actionButton(a, sel!)).join('');
    body = `<div class="sect">Buildings in ${esc(T.name)}</div>${blds}
      <div class="sect">Laws of ${esc(m.name)} · 1 AP each</div>${laws}
      <div class="muted" style="font-size:11px;margin-bottom:4px">${LAWS.filter((l) => l.active(m.laws) && l.id !== 'tax_normal').map((l) => esc(l.name + ': ' + l.effect)).join('<br>') || 'No special laws in force.'}</div>
      <div class="sect">Decrees</div>${decrees}`;
  } else {
    const cats: Cat[] = own ? ['military'] : ['political', 'covert', 'chaos', 'military'];
    if (!cats.includes(actTab)) actTab = cats[0];
    const all = listActions(S, m.id, sel);
    // hide permanently irrelevant entries to keep the menu uncluttered
    const hideIf = ['Not allied', 'No sanctions in place', 'Only your own puppets can be absorbed', 'Not at war', 'Only occupied lands can be annexed', 'Not a conquered land', 'Already at war', 'Already allied', 'Already sanctioned', 'Already trading'];
    const blurb: Record<string, string> = { political: 'Diplomacy and influence', covert: 'Secret operations', chaos: 'Spread unrest', military: own ? 'Troops and conquered land' : 'War' };
    body = cats.map((c) => {
      const list = all.filter((a) => a.cat === c && (!a.reason || !hideIf.includes(a.reason)));
      const open = c === actTab;
      return `<button class="group ${open ? 'open' : ''}" ${P.on(() => { actTab = c; sfx.click(); refresh(); })}>${c}<small>${blurb[c]} · ${list.filter((a) => !a.reason).length}/${list.length}</small></button>${open ? list.map((a) => actionButton(a, sel!)).join('') || '<div class="act" style="cursor:default"><span class="muted">Nothing to do here.</span></div>' : ''}`;
    }).join('');
  }
  left.innerHTML = `
    <button class="btn small ghost pclose" title="Back to empire overview" ${P.on(() => select(null))}>×</button>
    <div class="ptitle">${esc(T.name)}</div><div class="orn">◆</div>
    <div class="panel-head">${tags.join('')}</div>
    <div class="tabs" style="padding-top:0">${tabsFor.map((t) => `<button class="tab ${t === leftTab ? 'on' : ''}" ${P.on(() => { leftTab = t; sfx.click(); refresh(); })}>${tabLabel[t]}</button>`).join('')}</div>
    <div class="panel-body">${body}</div>`;
  const pb = left.querySelector('.panel-body');
  if (pb) pb.scrollTop = keep;
}

function landRow(t: Country) {
  return `<div class="list-row" ${P.on(() => select(t.id))}><span class="chip" style="background:${css(nationColor(S, t.owner))}"></span><span class="grow">${esc(t.name)}</span><span class="mono muted">${fmtTroops(t.troops)}</span><span class="mono ${t.unrest > 60 ? 'bad' : 'muted'}" title="unrest">${n0(t.unrest)}</span></div>`;
}

function actionButton(a: ActionView, tid: string) {
  const meta: string[] = [];
  if (a.ap) meta.push(`<span class="ap">${a.ap} AP</span>`);
  if (a.cost > 0) meta.push(fmtMoney(a.cost));
  const odds: string[] = [];
  if (a.chance != null) odds.push(`<span class="${a.chance >= 0.6 ? 'good' : a.chance >= 0.35 ? 'warn' : 'bad'}">${a.chance === 1 ? 'will accept' : a.chance === 0 ? 'will refuse' : pct(a.chance) + ' success'}</span>`);
  if (a.risk != null) odds.push(`<span class="${a.risk > 0.4 ? 'bad' : 'muted'}">${pct(a.risk)} detect</span>`);
  return `<button class="act" ${a.reason ? 'disabled' : ''} title="${esc(a.reason ?? a.desc)}" ${P.on(() => runAction(a.id, tid))}>
    <span class="nm"><b>${a.name}</b><small>${a.reason ? esc(a.reason) : esc(a.desc)}</small></span>
    <span class="meta">${meta.join(' · ')}${odds.length ? '<br>' + odds.join(' · ') : ''}</span></button>`;
}

function renderRight(powers: Record<string, PowerInfo>) {
  const right = $('right');
  const keep = right.querySelector('.panel-body')?.scrollTop ?? 0;
  const hadFocus = document.activeElement?.id === 'cmd';
  const names = { command: 'Command', advisors: 'Advisors', threats: 'Threats', log: 'Log' } as const;
  const titles = { command: 'Command Board', advisors: 'Council', threats: 'Threat Radar', log: 'Chronicle' } as const;
  const tabs = (['command', 'advisors', 'threats', 'log'] as const).map((t) => `<button class="tab ${t === rightTab ? 'on' : ''}" ${P.on(() => { rightTab = t; sfx.click(); refresh(); })}>${names[t]}</button>`).join('');
  let body = '';
  let foot = '';
  if (rightTab === 'command') {
    const live = ollama.enabled && !!ollama.model;
    body = `<div class="aide"><span>Aide: <b class="${live ? 'good' : ''}">${live ? 'Ollama · ' + esc(ollama.model) : 'offline parser'}</b></span><button class="btn small ghost" ${P.on(() => aideSettings())}>AI settings</button></div>
      <div class="muted" style="font-size:11.5px;margin-bottom:10px">${live ? 'Talk to your aide: ask for advice or give orders in your own words, and they are carried out.' : 'Type an order in plain words and your aide carries it out: deploy troops, run propaganda, change laws, make economic decisions.'} ${sel ? 'Orders without a country apply to <b>' + esc(S.countries[sel].name) + '</b>.' : 'Name a country or select one on the globe.'}</div>
      <div class="cmd-log">${cmdLog.map((e) => `<div class="cmd-q">${esc(e.q)}</div><div class="cmd-a ${e.ok ? 'good' : 'bad'}">${esc(e.say)}${e.res ? `<small>${esc(e.res).replace(/\n/g, '<br>')}</small>` : ''}</div>`).join('') || '<span class="muted">No orders issued yet.</span>'}</div>`;
    foot = `<div class="cmd-box"><textarea id="cmd" placeholder="e.g. Deploy 50k troops to the border with Syria" maxlength="200">${esc(cmdDraft)}</textarea>
      <div style="display:flex;align-items:center;gap:8px;margin-top:6px"><span class="muted" style="font-size:11px">Enter to send</span><span class="spacer"></span><button class="btn small primary" ${aideBusy ? 'disabled' : ''} ${P.on(() => void submitCommand())}>${aideBusy ? 'Thinking…' : 'Send'}</button></div>
      <div class="chips">${COMMAND_EXAMPLES.slice(0, 6).map((x) => `<button ${P.on(() => { cmdDraft = x; refresh(); (document.getElementById('cmd') as HTMLTextAreaElement | null)?.focus(); })}>${esc(x)}</button>`).join('')}</div></div>`;
  } else if (rightTab === 'advisors') {
    const list = advise(S);
    body = `<div class="muted" style="font-size:11.5px;margin-bottom:8px">Ranked by urgency. They sometimes disagree; the call is yours.</div>` + (list.map((a) => adviceCard(a)).join('') || '<span class="muted">Your advisors have nothing urgent to report.</span>');
  } else if (rightTab === 'threats') {
    const th = threatRadar(S, powers);
    const co = S.coalition;
    body = (co ? `<div class="card mil"><h4>${co.target === S.playerId ? 'Coalition against YOU' : 'Coalition against ' + esc(S.countries[co.target].name)}</h4><p>${co.members.map((id) => esc(S.countries[id].name)).join(', ')}</p></div>` : '') +
      `<div class="muted" style="font-size:11.5px;margin-bottom:8px">Who is most likely to attack you next, and why.</div>` +
      (th.map((t) => {
        const N = S.countries[t.id];
        return `<div class="card ${t.score > 0.6 ? 'mil' : 'dip'}" style="cursor:pointer" ${P.on(() => select(t.id))}><h4><span>${esc(N.name)}</span><span class="${t.score > 0.6 ? 'bad' : t.score > 0.3 ? 'warn' : 'muted'}">${t.atWar ? 'WAR' : pct(t.score)}</span></h4>${bar(t.score * 100, t.score > 0.6 ? 'var(--bad)' : 'var(--warn)')}<p style="margin-top:4px">${esc(t.reasons.join('; '))}.</p><div class="row"><span>army ${fmtTroops(powers[t.id]?.troops ?? 0)}</span><span>tech ${N.tech.toFixed(1)}</span><span>relations ${n0(rel(S, S.playerId!, t.id))}</span></div></div>`;
      }).join('') || '<span class="muted">No credible threats on your borders right now.</span>');
  } else {
    body = S.news.filter(visible).slice(-90).reverse().map((n) => `<div class="news k-${n.kind} i${n.importance}" ${n.ids[0] ? P.on(() => select(n.ids[0])) : ''} style="${n.ids[0] ? 'cursor:pointer' : ''}"><span class="t">${dateOf(n.turn)}</span>${esc(n.text)}</div>`).join('') || '<span class="muted">Nothing yet.</span>';
  }
  right.innerHTML = `<div class="ptitle">${titles[rightTab]}</div><div class="orn">◆</div><div class="tabs" style="padding-top:0">${tabs}</div><div class="panel-body">${body}</div>${foot}`;
  const b = right.querySelector('.panel-body');
  if (b) b.scrollTop = rightTab === 'command' ? b.scrollHeight : keep;
  const ta = document.getElementById('cmd') as HTMLTextAreaElement | null;
  if (ta) {
    ta.oninput = () => (cmdDraft = ta.value);
    ta.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submitCommand(); }
    };
    if (hadFocus) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }
}

async function probeOllama(auto = false) {
  try {
    ollamaModelsFound = await ollamaModels(ollama.url);
    // first run on a machine that has Ollama: switch the aide on with the first installed model
    if (auto && !ollama.saved && ollamaModelsFound.length) { ollama.enabled = true; ollama.model = ollamaModelsFound[0]; }
    if (ollamaModelsFound.length && !ollamaModelsFound.includes(ollama.model)) ollama.model = ollamaModelsFound[0];
  } catch {
    ollamaModelsFound = null;
  }
  if (phase === 'play') refresh();
}

function aideSettings() {
  M.clear();
  const found = ollamaModelsFound;
  openModal(`<div class="modal"><div class="modal-head"><span>AI aide (Ollama)</span><button class="btn small" ${M.on(() => closeModal())}>Close</button></div><div class="modal-body">
    <p class="muted" style="font-size:12px">The aide can be powered by a language model running on this computer through Ollama. Nothing is sent to the internet. When it is off or unreachable, the built-in offline parser handles your orders.</p>
    <div class="field"><label>Aide</label><div class="seg"><button class="btn small ${ollama.enabled ? 'on' : ''}" ${M.on(() => { ollama.enabled = true; saveOllamaConfig(ollama); refresh(); aideSettings(); })}>Ollama model</button><button class="btn small ${ollama.enabled ? '' : 'on'}" ${M.on(() => { ollama.enabled = false; saveOllamaConfig(ollama); refresh(); aideSettings(); })}>Offline parser</button></div></div>
    <div class="field"><label>Ollama address</label><div style="display:flex;gap:6px"><input type="text" id="ollama-url" value="${esc(ollama.url)}" style="flex:1"><button class="btn small" ${M.on(() => { ollama.url = ($('ollama-url') as HTMLInputElement).value.trim() || 'http://localhost:11434'; saveOllamaConfig(ollama); void probeOllama().then(() => aideSettings()); })}>Connect</button></div></div>
    <div class="field"><label>Model</label>${found === null ? `<span class="bad">Cannot reach Ollama at ${esc(ollama.url)}. Start it (run "ollama serve" or open the Ollama app), then press Connect.</span>` : found.length === 0 ? '<span class="warn">Ollama is running but has no models. Install one, for example "ollama pull qwen3:14b".</span>' : `<div class="seg" style="flex-wrap:wrap">${found.map((m) => `<button class="btn small ${m === ollama.model ? 'on' : ''}" ${M.on(() => { ollama.model = m; saveOllamaConfig(ollama); refresh(); aideSettings(); })}>${esc(m)}</button>`).join('')}</div>`}</div>
    <p class="muted" style="font-size:11.5px">The model only proposes actions; each one still costs AP and money and follows the normal rules. The first answer can take a while as the model loads.</p>
    </div></div>`, { dismiss: true });
}

async function submitCommand() {
  const q = cmdDraft.trim();
  if (!q || phase !== 'play' || S.over || aideBusy) return;
  if ($('overlay').classList.contains('on')) return;
  cmdDraft = '';
  const entry: { q: string; say: string; res?: string; ok: boolean } = { q, say: '', ok: true };
  cmdLog.push(entry);
  if (cmdLog.length > 30) cmdLog.shift();
  const game = S;
  const fights: { c: CombatResult; tid: string; ok: boolean }[] = [];
  const lines: string[] = [];
  const run = (id: string, tid: string, p: Params) => {
    const res = doAction(S, S.playerId!, id, tid, p);
    lines.push((res.ok ? '✓ ' : '✗ ') + res.msg + (res.detected && res.ok ? ' Your hand was detected.' : ''));
    if (!res.ok) entry.ok = false;
    if (res.combat) fights.push({ c: res.combat, tid, ok: res.ok });
    if (id === 'declare_war' && res.ok) sfx.war();
    else if (res.ok) sfx.ok();
    else sfx.fail();
  };
  const offline = () => {
    const order = interpret(S, q, sel);
    entry.say += order.say;
    entry.ok = order.ok;
    if (order.endTurn) return true;
    if (order.ok && order.act) run(order.act.id, order.act.tid, order.act.p);
    else sfx.fail();
    return false;
  };
  let endNow = false;
  if (ollama.enabled && ollama.model) {
    aideBusy = true;
    entry.say = 'Thinking…';
    refresh();
    try {
      const r = await askOllama(ollama, S, sel, chat, q);
      if (S !== game || phase !== 'play') return; // the game changed while the model was thinking
      entry.say = r.reply;
      chat.push({ role: 'user', content: q }, { role: 'assistant', content: JSON.stringify(r) });
      if (chat.length > 16) chat = chat.slice(-16);
      for (const a of r.actions) {
        if (S.over) break;
        const rs = resolveLlmAction(S, a, sel);
        if (rs.act) run(rs.act.id, rs.act.tid, rs.act.p);
        else { lines.push('✗ ' + (rs.error ?? 'could not do that')); entry.ok = false; }
      }
    } catch (err) {
      if (S !== game || phase !== 'play') return;
      ollamaModelsFound = null;
      entry.say = `(Ollama did not answer: ${err instanceof Error ? err.message : 'error'}. The offline aide takes over.) `;
      endNow = offline();
    } finally {
      aideBusy = false;
    }
  } else endNow = offline();
  if (lines.length) entry.res = lines.join('\n');
  refresh();
  if (endNow) return endTurnClick();
  if ($('overlay').classList.contains('on')) return;
  const last = fights[fights.length - 1];
  if (last) combatModal(last.c, last.tid, last.ok);
  else afterAction();
}

function adviceCard(a: Advice) {
  const p = PERSONAS[a.who];
  const row: string[] = [];
  if (a.chance != null) row.push(`<span class="${a.chance >= 0.6 ? 'good' : a.chance >= 0.4 ? 'warn' : 'bad'}">${pct(a.chance)} success</span>`);
  if (a.cost != null && a.cost > 0) row.push(`<span>${fmtMoney(a.cost)}</span>`);
  if (a.risk) row.push(`<span class="warn">risk: ${esc(a.risk)}</span>`);
  const v = a.act ? viewAction(S, S.playerId!, a.act.id, a.act.tid, a.act.p) : null;
  return `<div class="card ${p.cls}"><div class="who">${p.title} · ${p.name}${a.objection ? ' · <span class="warn">objects</span>' : ''}</div><h4>${esc(a.title)}</h4><p>${esc(a.why)}</p>
    <div class="row">${row.join('')}<span class="spacer"></span>${a.focus ? `<button class="btn small ghost" ${P.on(() => select(a.focus!))}>Show</button>` : ''}${a.act ? `<button class="btn small" ${v?.reason ? 'disabled title="' + esc(v.reason) + '"' : ''} ${P.on(() => runAction(a.act!.id, a.act!.tid, a.act!.p ?? {}))}>Do it${v && v.ap ? ' · ' + v.ap + ' AP' : ''}</button>` : ''}</div></div>`;
}

function renderTicker() {
  const items = S.news.filter(visible).slice(-18).reverse();
  const html = items.map((n) => `<span class="i${n.importance}">${esc(n.text)}</span>`).join('');
  const track = $('ticker-track');
  if (track.dataset.sig === String(S.news.length)) return;
  track.dataset.sig = String(S.news.length);
  track.innerHTML = html || '<span>The world is quiet. For now.</span>';
  track.style.animationDuration = Math.max(40, items.reduce((v, n) => v + n.text.length, 0) / 5) + 's';
}

// =====================================================================================
// ACTIONS
// =====================================================================================
function runAction(id: string, tid: string, p?: Params) {
  if (phase !== 'play' || S.over) return;
  if (!p) {
    if (id === 'attack') return theatreWindow(tid, 'attack');
    if (id === 'recruit') return recruitDialog(tid);
    if (id === 'move') return theatreWindow(tid, 'move');
    if (id === 'declare_war') return confirmWar(tid);
    p = {};
  }
  const res = doAction(S, S.playerId!, id, tid, p);
  if (id === 'declare_war' && res.ok) sfx.war();
  else if (res.ok) sfx.ok();
  else sfx.fail();
  toast(res.msg + (res.detected && res.ok ? ' Your hand was detected.' : ''), res.ok ? (res.detected ? '' : 'good') : 'bad');
  closeModal();
  refresh();
  if (res.combat) combatModal(res.combat, tid, res.ok);
  else afterAction();
}

function afterAction() {
  if (S.over) return endScreen();
  if (S.choices.length) showChoice();
}

function confirmWar(tid: string) {
  const N = S.countries[S.countries[tid].owner];
  const root = N.overlord ? S.countries[N.overlord] : N;
  const allies = root.allies.map((a) => S.countries[a].name);
  const pact = (me().pacts[root.id] ?? 0) > S.turn;
  openModal(`<div class="modal"><div class="modal-head">Declare war on ${esc(root.name)}?</div><div class="modal-body">
    <p>Infamy +${CONFIG.overstretch.infamyWar} (less if they wronged you). Relations with them collapse and trade ends.</p>
    ${allies.length ? `<p class="warn">Their allies may join: ${esc(allies.join(', '))}.</p>` : '<p class="good">They have no allies.</p>'}
    ${pact ? '<p class="bad">You have a non-aggression treaty with them. Breaking it is a betrayal the whole world will remember.</p>' : ''}
    </div><div class="modal-foot"><button class="btn" ${M.on(() => closeModal())}>Cancel</button><button class="btn danger" ${M.on(() => runAction('declare_war', tid, {}))}>Declare war</button></div></div>`, { dismiss: true });
}

function openTerrain() {
  if (phase !== 'play' || $('overlay').classList.contains('on')) return;
  const tid = sel ?? S.playerId;
  if (!tid) return toast('Select a country first');
  theatreWindow(tid, 'view');
}

/**
 * Terrain view: a relief map of the theatre around one country. Opened on its own ("Terrain" tab, key T)
 * or as the briefing step before a troop deployment / attack, where it leads on to the deployment dialog.
 */
function theatreWindow(tid: string, purpose: 'view' | 'attack' | 'move') {
  const T = S.countries[tid];
  const N = S.countries[T.owner];
  const pid = S.playerId;
  const marks: TerrainMark[] = [];
  let side = '';
  let proceed = '';
  M.clear();
  if (pid && purpose === 'attack') {
    const pts = launchPoints(S, pid, tid).filter((c) => c.troops > 0.2).sort((a, b) => b.troops - a.troops);
    marks.push({ id: tid, kind: 'target' }, ...pts.map((c) => ({ id: c.id, kind: 'own' as const })));
    side = `<div class="sect">Objective</div>${kv('Defenders', fmtTroops(T.troops), 'bad')}${kv('Terrain', T.terrain ? 'Rough: favours them' : 'Open')}${kv('Barracks', 'level ' + T.buildings.barracks)}${kv('Stability', n0(T.stability))}${kv('Their tech', N.tech.toFixed(1))}
      <div class="sect">Your launch points</div>${pts.map((c) => kv(esc(c.name) + (c.neighbors.includes(tid) ? '' : ' <span class="muted">(by sea)</span>'), fmtTroops(c.troops), 'acc')).join('') || '<span class="bad">No troops in an adjacent land.</span>'}`;
    proceed = `<button class="btn danger" ${pts.length ? '' : 'disabled'} ${M.on(() => attackDialog(tid))}>Proceed to deployment</button>`;
  } else if (pid && purpose === 'move') {
    const hostile = links(T).map((l) => S.countries[l]).filter((c) => c.owner !== pid && (me().wars.includes(c.owner) || rel(S, pid, c.owner) < -20));
    marks.push({ id: tid, kind: 'own' }, ...hostile.map((c) => ({ id: c.id, kind: 'enemy' as const })));
    side = `<div class="sect">Destination</div>${kv('Troops here now', fmtTroops(T.troops), 'acc')}${kv('Terrain', T.terrain ? 'Rough: good to defend' : 'Open')}${kv('Barracks', 'level ' + T.buildings.barracks)}${kv('Unrest', n0(T.unrest))}
      <div class="sect">Hostile neighbours</div>${hostile.map((c) => kv(esc(c.name) + (me().wars.includes(c.owner) ? ' <span class="bad">war</span>' : ''), fmtTroops(c.troops), 'bad')).join('') || '<span class="muted">None on this border.</span>'}`;
    proceed = `<button class="btn primary" ${M.on(() => moveDialog(tid))}>Proceed to deployment</button>`;
  } else {
    const nb = links(T).map((l) => S.countries[l]);
    side = `<div class="sect">${esc(T.name)}</div>${kv('Troops', fmtTroops(T.troops))}${kv('Terrain', T.terrain ? 'Rough' : 'Open')}${kv('Barracks', 'level ' + T.buildings.barracks)}${kv('Stability', n0(T.stability))}
      <div class="sect">Borders (${nb.length})</div>${nb.slice(0, 12).map((c) => kv(esc(c.name) + (T.seaLinks.includes(c.id) ? ' <span class="muted">(sea)</span>' : ''), fmtTroops(c.troops))).join('')}`;
  }
  const title = purpose === 'attack' ? 'Theatre of war · ' + T.name : purpose === 'move' ? 'Deployment area · ' + T.name : 'Terrain · ' + T.name;
  openModal(`<div class="modal terrain"><div class="modal-head"><span>${esc(title)}</span><span class="muted" style="font-size:10px;letter-spacing:1px">relief is illustrative</span></div>
    <div class="terrain-body"><canvas id="terrain-canvas" width="760" height="560"></canvas><div class="terrain-side">${side}
      <p class="muted" style="font-size:11px;margin-top:10px">${purpose === 'view' ? 'Borders, names and troop numbers are live game data.' : 'Red: enemy. Blue: your forces. Study the ground, then commit.'}</p></div></div>
    <div class="modal-foot"><button class="btn" ${M.on(() => closeModal())}>${purpose === 'view' ? 'Close' : 'Cancel'}</button>${proceed}</div></div>`, { dismiss: true });
  drawTerrain($('terrain-canvas') as HTMLCanvasElement, world, S, tid, marks);
}

function attackDialog(tid: string) {
  const T = S.countries[tid];
  const pts = launchPoints(S, S.playerId!, tid).filter((c) => c.troops > 0.2).sort((a, b) => b.troops - a.troops);
  if (!pts.length) return toast('No troops in an adjacent land you hold', 'bad');
  let from = pts[0];
  let share = 0.8;
  const render = () => {
    M.clear();
    const amount = from.troops * share;
    const o = previewAttack(S, S.playerId!, from.id, tid, amount);
    const D = S.countries[T.owner];
    openModal(`<div class="modal"><div class="modal-head">Attack ${esc(T.name)}<span class="muted" style="font-size:11px">what-if preview</span></div><div class="modal-body">
      <div class="field"><label>Launch from</label><div class="seg" style="flex-wrap:wrap">${pts.map((c) => `<button class="btn small ${c === from ? 'on' : ''}" ${M.on(() => { from = c; render(); })}>${esc(c.name)} (${fmtTroops(c.troops)})${c.neighbors.includes(tid) ? '' : ' · sea'}</button>`).join('')}</div></div>
      <div class="field"><label>Commit ${pct(share)} = ${fmtTroops(amount)} (${fmtTroops(from.troops - amount)} stay behind)</label><input type="range" min="10" max="100" value="${Math.round(share * 100)}" ${M.input((el) => { share = Number((el as HTMLInputElement).value) / 100; })} ${M.on(() => render())}></div>
      <div class="grid2">${kv('Your force', fmtTroops(amount))}${kv('Defenders', fmtTroops(T.troops))}${kv('Your tech', me().tech.toFixed(1))}${kv('Their tech', D.tech.toFixed(1))}${kv('Your dice modifier', (o.input ? '' : '') + fmtMod(o, 'att'))}${kv('Their dice modifier', fmtMod(o, 'def'))}</div>
      <div class="kv" style="margin-top:8px"><span>Estimated chance of victory</span><span class="${o.win >= 0.6 ? 'good' : o.win >= 0.4 ? 'warn' : 'bad'}" style="font-size:16px">${pct(o.win)}</span></div>${bar(o.win * 100, o.win >= 0.6 ? 'var(--good)' : o.win >= 0.4 ? 'var(--warn)' : 'var(--bad)')}
      <div class="grid2">${kv('Expected losses (you)', fmtTroops(o.attLoss))}${kv('Expected losses (them)', fmtTroops(o.defLoss))}</div>
      <p class="muted" style="font-size:11.5px">Risk-style dice: you roll up to ${CONFIG.combat.attDice}, they roll up to ${CONFIG.combat.defDice}; ties go to the defender. You retreat at ${pct(CONFIG.combat.retreatAt)} strength.${T.id === D.id ? ' This is their capital: taking it ends ' + esc(D.name) + '.' : ''}</p>
      </div><div class="modal-foot"><button class="btn" ${M.on(() => closeModal())}>Cancel</button><button class="btn danger" ${M.on(() => runAction('attack', tid, { from: from.id, amount: from.troops * share }))}>Attack · 1 AP</button></div></div>`, { dismiss: true });
  };
  render();
}

function fmtMod(o: ReturnType<typeof previewAttack>, side: 'att' | 'def') {
  // recompute cheaply from a single-sample battle input for display
  const b = o.input;
  const K = CONFIG.combat;
  const tech = Math.max(-K.techModMax, Math.min(K.techModMax, (b.attTech - b.defTech) * K.techMod));
  let att = (tech > 0 ? tech : 0) + (b.attStability - 50) * K.moraleMod - (b.amphibious ? K.amphibiousMalus : 0) - (b.attDisrupted ? K.disruptedMalus : 0);
  let def = (tech < 0 ? -tech : 0) + (b.defStability - 50) * K.moraleMod + b.terrain * K.terrainMod + (b.defHome ? K.homeFortMod : 0) - (b.defDisrupted ? K.disruptedMalus : 0);
  const v = side === 'att' ? att : def;
  return (v >= 0 ? '+' : '') + v.toFixed(2);
}

function recruitDialog(tid: string) {
  const m = me();
  const lands = territoriesOf(S, m.id);
  const room = Math.max(0, manpowerCap(lands, m.laws.conscription) - lands.reduce((v, t) => v + t.troops, 0));
  const per = recruitUnitCost(m, S.countries[tid]);
  const afford = Math.max(0, m.treasury / per);
  const max = Math.min(room, afford);
  if (max < 0.05) return toast(room < 0.05 ? 'Manpower exhausted (5% of population)' : 'Not enough money', 'bad');
  let share = 0.5;
  const render = () => {
    M.clear();
    const n = max * share;
    openModal(`<div class="modal"><div class="modal-head">Recruit in ${esc(S.countries[tid].name)}</div><div class="modal-body">
      <div class="field"><label>Raise ${fmtTroops(n)} for ${fmtMoney(n * per)}</label><input type="range" min="5" max="100" value="${Math.round(share * 100)}" ${M.input((el) => { share = Number((el as HTMLInputElement).value) / 100; })} ${M.on(() => render())}></div>
      <div class="grid2">${kv('Manpower left', fmtTroops(room))}${kv('Affordable', fmtTroops(afford))}${kv('Extra upkeep / month', fmtMoney(n * m.unitCost), 'warn')}${kv('Treasury after', fmtMoney(m.treasury - n * per))}</div>
      </div><div class="modal-foot"><button class="btn" ${M.on(() => closeModal())}>Cancel</button><button class="btn primary" ${M.on(() => runAction('recruit', tid, { amount: n }))}>Recruit · 1 AP</button></div></div>`, { dismiss: true });
  };
  render();
}

function moveDialog(tid: string) {
  const T = S.countries[tid];
  const srcs = territoriesOf(S, S.playerId!).filter((t) => t.id !== tid && t.troops > 0.2).sort((a, b) => b.troops - a.troops);
  if (!srcs.length) return toast('No other troops to move', 'bad');
  let from = srcs[0];
  let share = 0.5;
  const render = () => {
    M.clear();
    const n = from.troops * share;
    const adj = links(T).includes(from.id);
    const cost = adj ? 0 : n * me().unitCost * 2;
    openModal(`<div class="modal"><div class="modal-head">Deploy troops to ${esc(T.name)}</div><div class="modal-body">
      <div class="field"><label>From</label><div class="seg" style="flex-wrap:wrap">${srcs.slice(0, 12).map((c) => `<button class="btn small ${c === from ? 'on' : ''}" ${M.on(() => { from = c; render(); })}>${esc(c.name)} (${fmtTroops(c.troops)})</button>`).join('')}</div></div>
      <div class="field"><label>Move ${fmtTroops(n)} · ${adj ? 'adjacent, free' : 'air/naval transport ' + fmtMoney(cost)}</label><input type="range" min="5" max="100" value="${Math.round(share * 100)}" ${M.input((el) => { share = Number((el as HTMLInputElement).value) / 100; })} ${M.on(() => render())}></div>
      </div><div class="modal-foot"><button class="btn" ${M.on(() => closeModal())}>Cancel</button><button class="btn primary" ${M.on(() => runAction('move', tid, { from: from.id, amount: from.troops * share }))}>Move · no AP</button></div></div>`, { dismiss: true });
  };
  render();
}

function combatModal(c: CombatResult, tid: string, won: boolean) {
  const rounds = c.rounds.slice(0, 14).map((r, i) => {
    const pairs = Math.min(r.att.length, r.def.length);
    const die = (v: number, cls: string, lost: boolean) => `<span class="die ${cls} ${lost ? 'lose' : ''}">${v}</span>`;
    const a = r.att.map((v, k) => die(v, 'a', k < pairs && !r.won[k])).join('');
    const d = r.def.map((v, k) => die(v, 'd', k < pairs && r.won[k])).join('');
    return `<tr><td>${i + 1}</td><td><span class="dice">${a}</span></td><td><span class="dice">${d}</span></td><td class="bad">-${fmtTroops(r.attLost)}</td><td class="bad">-${fmtTroops(r.defLost)}</td></tr>`;
  }).join('');
  openModal(`<div class="modal"><div class="modal-head"><span>Battle of ${esc(S.countries[tid].name)}</span><span class="${won ? 'good' : 'bad'}">${won ? 'Victory' : 'Repulsed'}</span></div><div class="modal-body">
    <div class="grid2">${kv('Your force', `${fmtTroops(c.attStart)} → ${fmtTroops(c.attLeft)}`)}${kv('Defenders', `${fmtTroops(c.defStart)} → ${fmtTroops(c.defLeft)}`)}${kv('Your dice modifier', (c.attMod >= 0 ? '+' : '') + c.attMod.toFixed(2))}${kv('Their dice modifier', (c.defMod >= 0 ? '+' : '') + c.defMod.toFixed(2))}</div>
    ${c.notes.length ? `<p class="muted" style="font-size:11.5px">${c.notes.map(esc).join(' · ')}</p>` : ''}
    <table class="tbl"><tr><th>#</th><th>Your dice</th><th>Their dice</th><th>You lose</th><th>They lose</th></tr>${rounds}</table>
    ${c.rounds.length > 14 ? `<p class="muted">… ${c.rounds.length - 14} more exchanges.</p>` : ''}
    ${won ? `<p class="good">${esc(S.countries[tid].name)} is occupied. Annex it, install a puppet or liberate it from its panel.</p>` : '<p class="bad">Your surviving troops fall back.</p>'}
    </div><div class="modal-foot"><button class="btn primary" ${M.on(() => { closeModal(); select(tid, false); afterAction(); })}>Continue</button></div></div>`);
}

// =====================================================================================
// TURN FLOW
// =====================================================================================
function endTurnClick() {
  if (phase !== 'play' || S.over) return;
  if ($('overlay').classList.contains('on')) return;
  if (S.choices.length) return showChoice();
  sfx.turn();
  const rep = endTurn(S, runBots);
  saveGame(S);
  refresh();
  reportModal(rep);
}

function reportModal(rep: TurnReport) {
  const mine = rep.news.filter(involvesMe);
  const worldNews = rep.news.filter((n) => !involvesMe(n) && n.importance >= 2);
  if (mine.some((n) => n.kind === 'war' || n.kind === 'combat')) sfx.war();
  else if (mine.some((n) => n.importance === 3)) sfx.alert();
  const line = (n: NewsItem) => `<div class="news k-${n.kind} i${n.importance}">${esc(n.text)}</div>`;
  const d = (rep.shareAfter - rep.shareBefore) * 100;
  const b = rep.budget;
  openModal(`<div class="modal"><div class="modal-head"><span>Turn report · ${dateOf(rep.turn)}</span></div><div class="modal-body">
    <div class="grid2">${kv('Empire share', `${(rep.shareAfter * 100).toFixed(1)}% <span class="${d >= 0 ? 'good' : 'bad'}">${d >= 0 ? '+' : ''}${d.toFixed(2)}</span>`)}${b ? kv('Monthly balance', fmtMoney(b.net), b.net < 0 ? 'bad' : 'good') : ''}${kv('Territory changes', String(rep.changes.length))}${kv('Action points', `${S.ap}`)}</div>
    <div class="sect">Concerning you (${mine.length})</div>${mine.map(line).join('') || '<span class="muted">A quiet month at home.</span>'}
    <div class="sect">World headlines (${worldNews.length})</div>${worldNews.slice(0, 40).map(line).join('') || '<span class="muted">Nothing of note.</span>'}
    </div><div class="modal-foot"><button class="btn primary" ${M.on(() => { closeModal(); afterAction(); })}>Continue</button></div></div>`);
}

function showChoice() {
  const ch = S.choices[0];
  if (!ch) return;
  sfx.alert();
  M.clear();
  if (S.countries[ch.targetId]) globe.flyTo(ch.targetId);
  openModal(`<div class="modal"><div class="modal-head">${esc(ch.title)}</div><div class="modal-body"><p>${esc(ch.text)}</p>
    ${ch.options.map((o, i) => `<button class="act" ${M.on(() => { const msg = resolveChoice(S, ch.id, i); closeModal(); if (msg) toast(msg); refresh(); afterAction(); })}><span class="nm"><b>${esc(o.label)}</b><small style="white-space:normal">${esc(o.desc)}</small></span></button>`).join('')}
    </div></div>`);
}

// =====================================================================================
// LEADERBOARD / MENU / TUTORIAL / END
// =====================================================================================
function leaderboard() {
  const powers = computePowers(S);
  const rows = Object.values(powers).sort((a, b) => a.rank - b.rank).slice(0, 60).map((p) => {
    const N = S.countries[p.id];
    const st = p.id === S.playerId ? 'YOU' : N.overlord === S.playerId ? 'your puppet' : N.overlord ? 'puppet of ' + S.countries[N.overlord].name : me().wars.includes(p.id) ? 'AT WAR' : allied(S, S.playerId!, p.id) ? 'ally' : n0(rel(S, S.playerId!, p.id));
    return `<tr class="${p.id === S.playerId ? 'me' : ''}" ${M.on(() => { closeModal(); select(p.id); })}><td>${p.rank}</td><td><span class="chip" style="background:${css(nationColor(S, p.id))}"></span> ${esc(N.name)}</td><td>${(p.power * 100).toFixed(1)}</td><td>${(p.share * 100).toFixed(1)}%</td><td>${fmtMoney(p.gdp)}</td><td>${fmtTroops(p.troops)}</td><td>${p.territories}</td><td>${esc(st)}</td></tr>`;
  }).join('');
  openModal(`<div class="modal wide"><div class="modal-head"><span>World powers</span><button class="btn small" ${M.on(() => closeModal())}>Close</button></div><div class="modal-body">
    <p class="muted" style="font-size:11.5px">Power = (${CONFIG.power.wGdp}×GDP + ${CONFIG.power.wMil}×military, each normalised to the world leader) × a stability factor (${1 - CONFIG.power.wStab} to 1). Share = bloc share of world GDP + military, puppets included.</p>
    <table class="tbl"><tr><th>#</th><th>Nation</th><th>Power</th><th>Share</th><th>GDP</th><th>Army</th><th>Lands</th><th>Relations</th></tr>${rows}</table></div></div>`, { dismiss: true });
}

function menu() {
  const diffs: Difficulty[] = ['easy', 'normal', 'hard', 'brutal'];
  M.clear();
  openModal(`<div class="modal"><div class="modal-head"><span>Paused</span><button class="btn small" ${M.on(() => closeModal())}>Resume</button></div><div class="modal-body">
    <div class="field"><label>Sound</label><div class="seg"><button class="btn small ${isMuted() ? '' : 'on'}" ${M.on(() => { setMuted(false); sfx.ok(); refresh(); menu(); })}>On</button><button class="btn small ${isMuted() ? 'on' : ''}" ${M.on(() => { setMuted(true); refresh(); menu(); })}>Muted</button></div></div>
    <div class="field"><label>Difficulty (applies from now on)</label><div class="seg">${diffs.map((d) => `<button class="btn small ${d === S.difficulty ? 'on' : ''}" ${M.on(() => { S.difficulty = d; sfx.click(); refresh(); menu(); })}>${d}</button>`).join('')}</div></div>
    <div class="field"><label>Game · seed "${esc(S.seed)}"</label><div class="seg">
      <button class="btn" ${M.on(() => { toast(saveGame(S) ? 'Game saved' : 'Save failed', 'good'); })}>Save</button>
      <button class="btn" ${hasSave() ? '' : 'disabled'} ${M.on(() => continueGame())}>Load</button>
      <button class="btn" ${M.on(() => { closeModal(); tutorial(0); })}>Tutorial</button>
      <button class="btn danger" ${M.on(() => { closeModal(); sel = null; globe.select(null); startScreen(); })}>New game</button></div></div>
    <div class="sect">Controls</div>
    <p class="muted" style="font-size:12px">Drag: rotate · Scroll: zoom · Click: select country · 1-6: map modes · Space / Enter: end turn · Esc: close dialog.<br>The game autosaves at the end of every turn.</p>
    </div></div>`, { dismiss: true });
}

const TUT: { title: string; text: string; anchor: string; pos: string }[] = [
  { title: 'Welcome, leader', text: 'Your goal: bring 60% of the world\'s economic and military power under your control, by conquest, puppets or both. Lose your homeland, your stability or your treasury and it is over.', anchor: '', pos: 'left:50%;top:50%;transform:translate(-50%,-50%)' },
  { title: 'The top bar', text: 'Each month you get Action Points (AP). Almost everything costs AP and money. Watch Stability and Infamy: too much aggression unites the world against you.', anchor: '#topbar', pos: 'left:120px;top:60px' },
  { title: 'Countries and actions', text: 'Click any country on the globe. Overview shows its leader and stats. Develop (your own lands) builds farms, barracks and industry and changes laws. Actions lists what you can do there: political, covert, chaos and military.', anchor: '#left', pos: 'left:350px;top:140px' },
  { title: 'Command board and council', text: 'Type an order in plain words on the Command board ("deploy troops to the border with Syria", "raise taxes", "run propaganda in Iran") and it is carried out. The Advisors tab ranks recommendations with odds, cost and risk; Threats shows who may attack you and why.', anchor: '#right', pos: 'right:350px;top:140px' },
  { title: 'Map modes', text: 'Switch the globe between owner colours, economy, military, stability/chaos, your influence and relations. Red glows mark countries in chaos; chaos spreads to neighbours.', anchor: '#modes', pos: 'left:50%;bottom:90px;transform:translateX(-50%)' },
  { title: 'End the turn', text: 'When you are out of AP (or patience), press END TURN. Every AI leader acts, events fire and you get a report. Good luck.', anchor: '#endturn', pos: 'right:20px;top:60px' },
];
function tutorial(i: number) {
  document.querySelectorAll('.tut').forEach((e) => e.remove());
  document.querySelectorAll<HTMLElement>('[data-tut]').forEach((e) => { e.style.outline = ''; delete e.dataset.tut; });
  if (i >= TUT.length) { localStorage.setItem('dominai.tutorial', 'done'); return; }
  const t = TUT[i];
  const a = t.anchor ? document.querySelector<HTMLElement>(t.anchor) : null;
  if (a) { a.style.outline = '2px solid var(--accent)'; a.dataset.tut = '1'; }
  const el = document.createElement('div');
  el.className = 'tut';
  el.style.cssText = t.pos;
  el.innerHTML = `<h4>${t.title} <span class="muted">${i + 1}/${TUT.length}</span></h4><div>${t.text}</div><div style="display:flex;justify-content:flex-end;gap:6px;margin-top:10px"><button class="btn small ghost" data-k="skip">Skip</button><button class="btn small primary" data-k="next">${i === TUT.length - 1 ? 'Start' : 'Next'}</button></div>`;
  document.body.appendChild(el);
  el.querySelector<HTMLElement>('[data-k=skip]')!.onclick = () => tutorial(TUT.length);
  el.querySelector<HTMLElement>('[data-k=next]')!.onclick = () => { sfx.click(); tutorial(i + 1); };
}

function endScreen() {
  if (phase === 'over') return;
  phase = 'over';
  const o = S.over!;
  o.won ? sfx.win() : sfx.lose();
  saveGame(S);
  const powers = computePowers(S);
  const share = powers[S.playerId!]?.share ?? 0;
  const pts = S.history.map((h) => h.share);
  const maxS = Math.max(CONFIG.win.share, ...pts, 0.01);
  const W = 560, H = 120;
  const path = pts.map((v, i) => `${i ? 'L' : 'M'}${((i / Math.max(1, pts.length - 1)) * W).toFixed(1)} ${(H - (v / maxS) * (H - 8) - 4).toFixed(1)}`).join(' ');
  const st = S.stats;
  M.clear();
  openModal(`<div class="modal wide"><div class="modal-head"><span class="${o.won ? 'good' : 'bad'}">${o.won ? 'World domination achieved' : 'Your rule has ended'}</span><span class="muted">${dateOf(o.turn)}</span></div><div class="modal-body">
    <p style="font-size:14px">${esc(o.reason)}</p>
    <div class="grid2">${kv('Months in power', String(o.turn + 1))}${kv('Final empire share', (share * 100).toFixed(1) + '%')}${kv('Peak share', (Math.max(0, ...pts) * 100).toFixed(1) + '%')}${kv('Lands held', String(territoriesOf(S, S.playerId!).length))}
      ${kv('Battles won / lost', `${st.battlesWon} / ${st.battlesLost}`)}${kv('Wars declared', String(st.warsDeclared))}${kv('Lands annexed', String(st.annexed))}${kv('Puppets made', String(st.puppets))}
      ${kv('Covert & chaos ops', String(st.ops))}${kv('Ops detected', String(st.opsDetected))}</div>
    <div class="sect">Empire share over time</div>
    <svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><line x1="0" x2="${W}" y1="${H - (CONFIG.win.share / maxS) * (H - 8) - 4}" y2="${H - (CONFIG.win.share / maxS) * (H - 8) - 4}" stroke="#96856b" stroke-dasharray="4 4"/><path d="${path}" fill="none" stroke="#dba94a" stroke-width="2"/></svg>
    <div class="sect">Timeline replay</div><div id="replay-label" class="mono muted">Watch the map change from the first month to the last.</div>
    </div><div class="modal-foot"><button class="btn" ${M.on(() => replay())}>Play timeline on the globe</button><button class="btn primary" ${M.on(() => { clearSave(); closeModal(); sel = null; globe.select(null); startScreen(); })}>New game</button></div></div>`, { clear: true });
  $('left').innerHTML = '';
  $('right').innerHTML = '';
}

function replay() {
  clearInterval(replayTimer);
  const owners: Record<string, string> = { ...S.startOwners };
  const paintAll = () => { for (const id of S.ids) { const col = nationColor(S, owners[id]); globe.painter.paint(id, col); painted.set(id, col); } };
  paintAll();
  globe.autoRotate = true;
  let i = 0;
  replayTimer = window.setInterval(() => {
    const label = document.getElementById('replay-label');
    if (i >= S.history.length || !label) {
      clearInterval(replayTimer);
      if (label) label.textContent = 'Replay finished.';
      return;
    }
    const h = S.history[i++];
    for (const [tid, owner] of h.changes) {
      const old = painted.get(tid)!;
      owners[tid] = owner;
      const col = nationColor(S, owner);
      globe.fade(tid, old, col);
      painted.set(tid, col);
      globe.pulse(tid, '#ffffff', 0.05);
    }
    label.textContent = `${dateOf(h.turn)} · your share ${(h.share * 100).toFixed(1)}% · ${h.changes.length} land(s) changed hands`;
  }, 140);
}
