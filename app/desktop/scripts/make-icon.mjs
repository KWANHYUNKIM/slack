// 앱 아이콘 placeholder를 만든다 (resources/icon.png, 1024x1024).
// 출처: 이 스크립트가 직접 그린 도형(둥근 사각형 배경 + 말풍선)이다. 외부 이미지·로고를 쓰지 않는다.
// electron-builder가 이 PNG에서 mac icns, Windows ico를 만든다.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const SIZE = 1024;
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'icon.png');

const BG = [79, 70, 229]; // 남색
const FG = [255, 255, 255];

/** 중심 (cx, cy), 반폭 (hw, hh), 모서리 반지름 r인 둥근 사각형 안인지 */
function inRoundRect(x, y, cx, cy, hw, hh, r) {
  const dx = Math.max(Math.abs(x - cx) - (hw - r), 0);
  const dy = Math.max(Math.abs(y - cy) - (hh - r), 0);
  return dx * dx + dy * dy <= r * r;
}

/** 삼각형 (a, b, c) 안인지 */
function inTriangle(x, y, [ax, ay], [bx, by], [cx, cy]) {
  const s = (px, py, qx, qy, rx, ry) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry);
  const d1 = s(x, y, ax, ay, bx, by);
  const d2 = s(x, y, bx, by, cx, cy);
  const d3 = s(x, y, cx, cy, ax, ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

function sample(x, y) {
  if (!inRoundRect(x, y, 512, 512, 464, 464, 200)) return null;
  const bubble =
    inRoundRect(x, y, 512, 470, 290, 210, 120) || inTriangle(x, y, [330, 620], [460, 660], [300, 790]);
  // 말풍선 안의 점 세 개(배경색으로 뚫는다)
  const dot = [392, 512, 632].some((cx) => (x - cx) ** 2 + (y - 470) ** 2 <= 42 * 42);
  return bubble && !dot ? FG : BG;
}

// 2x2 슈퍼샘플링으로 가장자리를 부드럽게 한다
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y += 1) {
  const row = y * (SIZE * 4 + 1);
  raw[row] = 0; // 필터 없음
  for (let x = 0; x < SIZE; x += 1) {
    let r = 0, g = 0, b = 0, a = 0;
    for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
      const c = sample(x + ox, y + oy);
      if (!c) continue;
      r += c[0]; g += c[1]; b += c[2]; a += 1;
    }
    const i = row + 1 + x * 4;
    if (a) {
      raw[i] = Math.round(r / a);
      raw[i + 1] = Math.round(g / a);
      raw[i + 2] = Math.round(b / a);
    }
    raw[i + 3] = Math.round((a / 4) * 255);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // 비트 깊이
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
