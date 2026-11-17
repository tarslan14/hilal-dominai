// Draws the dominAI icon (gold-ringed globe) and writes launcher/dominai.ico. No dependencies.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const N = 256;
const px = Buffer.alloc(N * N * 4);
const set = (x, y, r, g, b, a) => {
  const i = (y * N + x) * 4;
  const ia = px[i + 3] / 255, na = a / 255, oa = na + ia * (1 - na);
  if (oa <= 0) return;
  px[i] = (r * na + px[i] * ia * (1 - na)) / oa;
  px[i + 1] = (g * na + px[i + 1] * ia * (1 - na)) / oa;
  px[i + 2] = (b * na + px[i + 2] * ia * (1 - na)) / oa;
  px[i + 3] = oa * 255;
};
const cx = 128, cy = 128, R = 104;
const aa = (d) => Math.max(0, Math.min(1, 0.5 - d)); // 1px soft edge
for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
  const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy);
  // dark rounded plate
  const plate = aa(Math.max(Math.abs(dx), Math.abs(dy)) - 122);
  if (plate > 0) set(x, y, 21, 15, 9, 255 * plate);
  // ocean with a soft light from the upper left
  const inG = aa(d - R);
  if (inG > 0) {
    const l = Math.max(0, 1 - Math.hypot(dx + 38, dy + 42) / 190);
    set(x, y, 8 + 22 * l, 26 + 50 * l, 46 + 70 * l, 255 * inG);
    // graticule: meridians (ellipses) and parallels
    const ny = dy / R;
    const half = Math.sqrt(Math.max(0, 1 - ny * ny)) * R;
    let line = 0;
    for (const k of [0, 0.38, 0.72]) for (const sgn of [-1, 1]) line = Math.max(line, aa(Math.abs(dx - sgn * k * half) - 1.1));
    for (const k of [-0.55, 0, 0.55]) line = Math.max(line, aa(Math.abs(dy - k * R) - 1.1));
    if (line > 0) set(x, y, 219, 169, 74, 150 * line * inG);
  }
  // gold ring + outer glow
  const ring = aa(Math.abs(d - R) - 4);
  if (ring > 0) set(x, y, 233, 189, 99, 255 * ring);
  const glow = Math.max(0, 1 - Math.abs(d - R - 6) / 10);
  if (glow > 0 && d > R) set(x, y, 219, 169, 74, 70 * glow);
}
// small diamond on top, as in the menu ornaments
for (let y = 6; y < 34; y++) for (let x = 114; x < 142; x++) {
  const a = aa(Math.abs(x - 128) + Math.abs(y - 20) - 11);
  if (a > 0) set(x, y, 243, 208, 137, 255 * a);
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const raw = Buffer.alloc(N * (N * 4 + 1));
for (let y = 0; y < N; y++) px.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);

// ICO container with one PNG-compressed 256x256 image
const head = Buffer.alloc(22);
head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);
head[6] = 0; head[7] = 0; head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12);
head.writeUInt32LE(png.length, 14); head.writeUInt32LE(22, 18);
fs.writeFileSync(path.join(__dirname, 'dominai.ico'), Buffer.concat([head, png]));
fs.writeFileSync(path.join(__dirname, 'dominai.png'), png);
console.log('icon written');
