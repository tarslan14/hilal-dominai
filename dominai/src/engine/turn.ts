import { CONFIG } from './config';
import { budgetOf, economyTick, type Budget } from './economy';
import { rollEvents } from './events';
import { apMax, computePowers, nations, addNews, type PowerInfo } from './state';
import { diplomacyTick, spreadChaos, stabilityTick } from './tick';
import type { GameState, NewsItem } from './types';

export interface TurnReport {
  turn: number; // the month that was just resolved
  news: NewsItem[];
  shareBefore: number;
  shareAfter: number;
  budget: Budget | null;
  changes: [string, string][];
}

/**
 * Resolves one month. `runBots` is injected so the engine stays independent of the AI module.
 * Order: bots act -> chaos spreads -> stability/rebellions/coups -> economy -> diplomacy/coalitions -> events -> victory check.
 */
export function endTurn(s: GameState, runBots: (s: GameState) => void): TurnReport {
  const mark = s.news.length;
  const before = s.playerId ? computePowers(s)[s.playerId]?.share ?? 0 : 0;
  if (!s.over) {
    runBots(s);
    spreadChaos(s);
    stabilityTick(s);
    economyTick(s);
    const powers = computePowers(s);
    diplomacyTick(s, powers);
    rollEvents(s);
  }
  const powers = computePowers(s);
  const changes = s.pendingChanges.splice(0);
  recordHistory(s, powers, changes);
  checkVictory(s, powers);
  const report: TurnReport = {
    turn: s.turn, news: s.news.slice(mark), shareBefore: before,
    shareAfter: s.playerId ? powers[s.playerId]?.share ?? 0 : 0,
    budget: s.playerId && s.countries[s.playerId].alive ? budgetOf(s, s.playerId) : null, changes,
  };
  s.turn++;
  s.ap = apMax(s);
  if (s.news.length > 500) s.news.splice(0, s.news.length - 500);
  return report;
}

function recordHistory(s: GameState, powers: Record<string, PowerInfo>, changes: [string, string][]) {
  const top = Object.values(powers).filter((p) => !s.countries[p.id].overlord).sort((a, b) => b.share - a.share).slice(0, 5)
    .map((p) => [p.id, Math.round(p.share * 1000) / 1000] as [string, number]);
  const share = s.playerId ? powers[s.playerId]?.share ?? 0 : top[0]?.[1] ?? 0;
  s.history.push({ turn: s.turn, share: Math.round(share * 1000) / 1000, top, changes });
}

export function checkVictory(s: GameState, powers: Record<string, PowerInfo> = computePowers(s)) {
  if (s.over || !s.playerId) return;
  const me = s.countries[s.playerId];
  if (!me.alive) {
    s.over = { won: false, reason: 'Your nation no longer exists.', turn: s.turn };
    return;
  }
  const share = powers[s.playerId]?.share ?? 0;
  const others = nations(s).filter((n) => n.id !== s.playerId && n.overlord !== s.playerId);
  if (share >= CONFIG.win.share || others.length === 0) {
    s.over = { won: true, reason: others.length === 0 ? 'Every nation on Earth answers to you.' : `Your bloc controls ${(share * 100).toFixed(0)}% of the world's economic and military power.`, turn: s.turn };
    addNews(s, 'system', 'The world is yours.', 3, [s.playerId]);
  }
}
