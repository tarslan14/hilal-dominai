import type { Gov, Leader } from '../engine/types';

// Procedural "portrait-style" leader avatar (inline SVG) driven by the leader's seed.
export function avatarSvg(leader: Leader, gov: Gov, size = 56): string {
  let x = leader.seed >>> 0;
  const r = () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 4294967296);
  const skins = ['#f2d3b8', '#e3b48f', '#c98f64', '#a26a43', '#7a4a2c', '#5a3520'];
  const hairs = ['#16110d', '#3a2616', '#6b4423', '#8d8d8d', '#d9d2c0', '#a8571f'];
  const skin = skins[Math.floor(r() * skins.length)];
  const hair = hairs[Math.floor(r() * hairs.length)];
  const suit = { democracy: '#27496d', autocracy: '#3b3b46', monarchy: '#6d2740', oneparty: '#7a1f1f', theocracy: '#20201c', junta: '#4a5a2a', hybrid: '#35465a', failed: '#54452c' }[gov];
  const fw = 15 + r() * 4;
  const style = Math.floor(r() * 5);
  const beard = r() < 0.3;
  const glasses = r() < 0.25;
  const old = leader.traits.paranoia > 0.6;
  const brow = leader.traits.aggression > 0.6 ? 2.2 : -0.6;
  const mouth = leader.traits.diplomacy > 0.55 ? 'M24 45 q8 5 16 0' : leader.traits.aggression > 0.6 ? 'M25 47 q7 -3 14 0' : 'M25 46 h14';
  const hairPath = [
    `M${32 - fw} 26 q0 -19 ${fw} -19 q${fw} 0 ${fw} 19 q-4 -11 -${fw} -11 q-${fw - 4} 0 -${fw} 11z`,
    `M${32 - fw} 28 q-2 -22 ${fw} -22 q${fw + 2} 0 ${fw} 22 l-3 -9 q-${fw - 3} -6 -${2 * fw - 6} 0z`,
    `M${32 - fw + 1} 22 q${fw - 1} -17 ${2 * fw - 2} 0 q-${fw - 1} -8 -${2 * fw - 2} 0z`,
    `M${32 - fw - 1} 40 q-4 -34 ${fw + 1} -34 q${fw + 5} 0 ${fw + 1} 34 l-2 -16 q-${fw - 1} -9 -${2 * fw - 2} 0z`,
    '',
  ][style];
  const cap = gov === 'junta' ? `<path d="M${30 - fw} 20 q${fw + 2} -15 ${2 * fw + 4} 0 v4 h-${2 * fw + 4}z" fill="#3c4a22"/><rect x="${28 - fw}" y="22" width="${2 * fw + 8}" height="3" fill="#20280f"/><circle cx="32" cy="15" r="2" fill="#e8c14a"/>` : '';
  const crown = gov === 'monarchy' ? '<path d="M21 13 l3 -8 4 6 4 -8 4 8 4 -6 3 8z" fill="#e8c14a"/>' : '';
  return `<svg width="${size}" height="${size * 1.14}" viewBox="0 0 64 73" xmlns="http://www.w3.org/2000/svg">
<rect width="64" height="73" fill="#0b1622"/>
<path d="M6 73 q2 -19 26 -19 q24 0 26 19z" fill="${suit}"/><path d="M27 54 l5 8 5 -8z" fill="#e9eef2"/>
<rect x="27" y="46" width="10" height="10" fill="${skin}"/>
<ellipse cx="32" cy="32" rx="${fw}" ry="19" fill="${skin}"/>
${hairPath ? `<path d="${hairPath}" fill="${hair}"/>` : ''}${cap}${crown}
<path d="M${23} ${27 + brow} l7 ${-brow}" stroke="${hair}" stroke-width="1.8" /><path d="M${41} ${27 + brow} l-7 ${-brow}" stroke="${hair}" stroke-width="1.8"/>
<circle cx="26.5" cy="31" r="1.7" fill="#111"/><circle cx="37.5" cy="31" r="1.7" fill="#111"/>
${glasses ? '<g fill="none" stroke="#111" stroke-width="1"><circle cx="26.5" cy="31" r="4.2"/><circle cx="37.5" cy="31" r="4.2"/><path d="M30.7 31h2.6"/></g>' : ''}
<path d="M32 33 v6 h-2.5" fill="none" stroke="rgba(0,0,0,.35)" stroke-width="1.2"/>
${old ? '<path d="M22 38 q2 2 4 1 M42 38 q-2 2 -4 1" stroke="rgba(0,0,0,.25)" fill="none"/>' : ''}
${beard ? `<path d="M${32 - fw + 2} 38 q${fw - 2} 22 ${2 * fw - 4} 0 q-${fw - 2} 8 -${2 * fw - 4} 0z" fill="${hair}" opacity=".92"/>` : ''}
<path d="${mouth}" fill="none" stroke="#5a1f1f" stroke-width="1.6" stroke-linecap="round"/>
</svg>`;
}
