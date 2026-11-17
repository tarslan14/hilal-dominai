// Deterministic seeded RNG (mulberry32). The generator state lives inside the game state,
// so a game saved and reloaded continues with exactly the same random sequence.

export interface RngHolder {
  rng: number;
}

export function hashSeed(seed: string): number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

export function rand(s: RngHolder): number {
  s.rng = (s.rng + 0x6d2b79f5) >>> 0;
  let t = s.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export const randRange = (s: RngHolder, a: number, b: number) => a + (b - a) * rand(s);
export const randInt = (s: RngHolder, a: number, b: number) => Math.floor(randRange(s, a, b + 1));
export const chance = (s: RngHolder, p: number) => rand(s) < p;
export const pick = <T>(s: RngHolder, arr: T[]): T => arr[Math.floor(rand(s) * arr.length)];
export const d6 = (s: RngHolder) => 1 + Math.floor(rand(s) * 6);

export function shuffle<T>(s: RngHolder, arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand(s) * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
