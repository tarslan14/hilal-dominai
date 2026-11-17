import type { GameState } from '../engine/types';

const KEY = 'dominai.save.v2';

export function saveGame(s: GameState): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...s, fx: [] }));
    return true;
  } catch {
    return false;
  }
}

export function loadGame(): GameState | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as GameState;
    if (s.version !== 2 || !s.countries || !s.ids) return null;
    s.fx = [];
    return s;
  } catch {
    return null;
  }
}

export const hasSave = () => localStorage.getItem(KEY) != null;
export const clearSave = () => localStorage.removeItem(KEY);
