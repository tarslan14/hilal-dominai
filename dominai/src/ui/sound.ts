// Tiny synthesized UI sounds via the Web Audio API (no assets).
let ctx: AudioContext | null = null;
let muted = localStorage.getItem('dominai.muted') === '1';

export const isMuted = () => muted;
export function setMuted(m: boolean) {
  muted = m;
  localStorage.setItem('dominai.muted', m ? '1' : '0');
}

function tone(freq: number, dur: number, type: OscillatorType = 'sine', vol = 0.05, delay = 0, slideTo?: number) {
  if (muted) return;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  } catch {
    /* audio unavailable: stay silent */
  }
}

export const sfx = {
  click: () => tone(880, 0.05, 'square', 0.02),
  select: () => tone(520, 0.08, 'sine', 0.04, 0, 780),
  ok: () => { tone(523, 0.09, 'triangle', 0.05); tone(784, 0.14, 'triangle', 0.05, 0.08); },
  fail: () => tone(196, 0.22, 'sawtooth', 0.035, 0, 110),
  alert: () => { tone(660, 0.1, 'square', 0.03); tone(660, 0.1, 'square', 0.03, 0.16); },
  war: () => { tone(110, 0.4, 'sawtooth', 0.05, 0, 55); tone(82, 0.5, 'square', 0.03, 0.05); },
  turn: () => { tone(330, 0.12, 'sine', 0.04); tone(440, 0.12, 'sine', 0.04, 0.1); tone(660, 0.2, 'sine', 0.04, 0.2); },
  win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.3, 'triangle', 0.05, i * 0.15)),
  lose: () => [392, 330, 262, 196].forEach((f, i) => tone(f, 0.4, 'sawtooth', 0.035, i * 0.2)),
};
