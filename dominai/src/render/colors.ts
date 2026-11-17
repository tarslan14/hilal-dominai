import { atWar, allied, rel, type PowerInfo } from '../engine/state';
import type { GameState } from '../engine/types';
import { hsl, mix, type RGB } from './painter';

export type MapMode = 'political' | 'economy' | 'military' | 'stability' | 'influence' | 'relations';
export const MAP_MODES: { id: MapMode; label: string; hint: string }[] = [
  { id: 'political', label: 'Political', hint: 'Who owns what' },
  { id: 'economy', label: 'Economy', hint: 'GDP (log scale)' },
  { id: 'military', label: 'Military', hint: 'Troops stationed (log scale)' },
  { id: 'stability', label: 'Stability', hint: 'Green = stable, red = chaos' },
  { id: 'influence', label: 'Influence', hint: 'Your political influence' },
  { id: 'relations', label: 'Relations', hint: 'Attitude towards you' },
];

export const PLAYER_RGB: RGB = [0, 229, 255];
const DARK: RGB = [22, 30, 40];

export function nationColor(s: GameState, id: string): RGB {
  if (id === s.playerId) return PLAYER_RGB;
  const c = s.countries[id];
  return hsl(c.hue, 42, 40);
}

const ramp = (t: number, a: RGB, b: RGB, c: RGB): RGB => (t < 0.5 ? mix(a, b, t * 2) : mix(b, c, (t - 0.5) * 2));

export function colorFor(s: GameState, mode: MapMode, id: string, _powers?: Record<string, PowerInfo>): RGB {
  const c = s.countries[id];
  const me = s.playerId;
  switch (mode) {
    case 'political': {
      let col = nationColor(s, c.owner);
      const ownerNation = s.countries[c.owner];
      if (ownerNation.overlord) col = mix(col, nationColor(s, ownerNation.overlord), 0.55); // puppets lean to overlord colour
      if (c.status === 'occupied') col = mix(col, [10, 10, 14], 0.4);
      return col;
    }
    case 'economy': {
      const t = Math.min(1, Math.max(0, Math.log10(c.gdp + 1) / 4.4));
      return ramp(t, [16, 34, 40], [20, 120, 96], [150, 255, 120]);
    }
    case 'military': {
      const t = Math.min(1, Math.max(0, Math.log10(c.troops + 1) / 3.3));
      return ramp(t, [30, 24, 34], [150, 50, 60], [255, 170, 60]);
    }
    case 'stability': {
      const t = Math.min(1, Math.max(0, (c.stability - c.unrest * 0.5 + 20) / 100));
      return ramp(t, [215, 40, 50], [190, 150, 50], [40, 170, 110]);
    }
    case 'influence': {
      if (!me) return DARK;
      if (c.owner === me) return PLAYER_RGB;
      if (s.countries[c.owner].overlord === me) return mix(PLAYER_RGB, [190, 90, 255], 0.5);
      const inf = s.countries[c.owner].influence[me] ?? 0;
      return mix([26, 24, 44], [200, 90, 255], inf / 100);
    }
    case 'relations': {
      if (!me) return DARK;
      if (c.owner === me) return PLAYER_RGB;
      const o = c.owner;
      if (atWar(s, me, o)) return [255, 40, 60];
      if (allied(s, me, o)) return [70, 130, 255];
      const r = rel(s, me, o);
      return r < 0 ? mix([70, 74, 84], [200, 70, 50], -r / 100) : mix([70, 74, 84], [60, 200, 110], r / 100);
    }
  }
}
