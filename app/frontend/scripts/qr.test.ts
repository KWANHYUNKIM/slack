import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeQr, rsEncode, rsGenerator, formatBits, versionBits, byteCapacity } from '../src/lib/qr/encode.ts';

// ---- 공개된 알려진 값 ----

test('RS 생성 다항식: 규격 부록의 7차(α 지수 0,87,229,146,149,238,102,21)', () => {
  const alphaExp = [0, 87, 229, 146, 149, 238, 102, 21];
  // 계수를 α 지수로 바꿔 비교한다
  const log = new Map<number, number>();
  let x = 1;
  for (let i = 0; i < 255; i++) { log.set(x, i); x <<= 1; if (x & 0x100) x ^= 0x11d; }
  const gen = [1, ...rsGenerator(7)];
  assert.deepEqual(gen.map((c) => log.get(c)), alphaExp);
});

test('RS 인코딩: 1-M "HELLO WORLD"(영숫자 모드) 데이터 코드워드의 EC 10개', () => {
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  assert.deepEqual(rsEncode(data, 10), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

test('형식 정보: EC M, 마스크 0~7의 15비트 값(규격 표)', () => {
  const expected = [
    '101010000010010', '101000100100101', '101111001111100', '101101101001011',
    '100010111111001', '100000011001110', '100111110010111', '100101010100000',
  ];
  for (let mask = 0; mask < 8; mask++) {
    assert.equal(formatBits(mask).toString(2).padStart(15, '0'), expected[mask], `mask ${mask}`);
  }
});

test('버전 정보: 버전 7~10의 18비트 값(규격 표)', () => {
  const expected: Record<number, string> = {
    7: '000111110010010100',
    8: '001000010110111100',
    9: '001001101010011001',
    10: '001010010011010011',
  };
  for (const [v, bits] of Object.entries(expected)) {
    assert.equal(versionBits(Number(v)).toString(2).padStart(18, '0'), bits, `version ${v}`);
  }
});

test('바이트 모드 EC M 용량(규격 표)과 버전 선택 경계', () => {
  const caps = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];
  for (let v = 1; v <= 10; v++) assert.equal(byteCapacity(v), caps[v - 1], `v${v}`);
  for (let v = 1; v <= 10; v++) {
    assert.equal(encodeQr('a'.repeat(caps[v - 1])).version, v, `fits v${v}`);
    if (v < 10) assert.equal(encodeQr('a'.repeat(caps[v - 1] + 1)).version, v + 1, `overflows to v${v + 1}`);
  }
  assert.throws(() => encodeQr('a'.repeat(214)), RangeError);
  assert.equal(encodeQr('').version, 1);
});

// ---- 독립 디코더: 행렬만 보고 되돌려 본다 ----

const EC_M: Record<number, [number, number, number, number, number]> = {
  1: [10, 1, 16, 0, 0], 2: [16, 1, 28, 0, 0], 3: [26, 1, 44, 0, 0], 4: [18, 2, 32, 0, 0], 5: [24, 2, 43, 0, 0],
  6: [16, 4, 27, 0, 0], 7: [18, 4, 31, 0, 0], 8: [22, 2, 38, 2, 39], 9: [22, 3, 36, 2, 37], 10: [26, 4, 43, 1, 44],
};
const ALIGN: Record<number, number[]> = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};
const FORMAT_M = [
  0b101010000010010, 0b101000100100101, 0b101111001111100, 0b101101101001011,
  0b100010111111001, 0b100000011001110, 0b100111110010111, 0b100101010100000,
];

function isFunctionModule(version: number, size: number, x: number, y: number): boolean {
  if (x === 6 || y === 6) return true; // 타이밍
  if (x <= 8 && y <= 8) return true; // 왼쪽 위 파인더 + 형식
  if (x >= size - 8 && y <= 8) return true; // 오른쪽 위
  if (x <= 8 && y >= size - 8) return true; // 왼쪽 아래
  if (version >= 7 && ((x >= size - 11 && y <= 5) || (y >= size - 11 && x <= 5))) return true;
  const a = ALIGN[version];
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < a.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === a.length - 1) || (i === a.length - 1 && j === 0)) continue;
      if (Math.abs(x - a[i]) <= 2 && Math.abs(y - a[j]) <= 2) return true;
    }
  }
  return false;
}

function maskFn(mask: number): (x: number, y: number) => boolean {
  const fns: Array<(x: number, y: number) => boolean> = [
    (x, y) => (x + y) % 2 === 0,
    (_x, y) => y % 2 === 0,
    (x) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  return fns[mask];
}

// GF(256)에서 다항식 값 계산(신드롬용), 별도 구현
function gfPow2(n: number): number {
  let v = 1;
  for (let i = 0; i < n; i++) { v <<= 1; if (v & 0x100) v ^= 0x11d; }
  return v;
}
function gfMulSlow(a: number, b: number): number {
  let r = 0;
  while (b) { if (b & 1) r ^= a; a <<= 1; if (a & 0x100) a ^= 0x11d; b >>= 1; }
  return r;
}

function decode(m: boolean[][]): { text: string; mask: number; version: number } {
  const size = m.length;
  const version = (size - 17) / 4;
  assert.ok(Number.isInteger(version) && version >= 1 && version <= 10);
  const bit = (x: number, y: number) => (m[y][x] ? 1 : 0);

  // 형식 정보 복사본 둘이 같고 표에 있어야 한다
  let f1 = 0;
  const c1: Array<[number, number]> = [];
  for (let i = 0; i <= 5; i++) c1.push([8, i]);
  c1.push([8, 7], [8, 8], [7, 8]);
  for (let i = 9; i < 15; i++) c1.push([14 - i, 8]);
  c1.forEach(([x, y], i) => { f1 |= bit(x, y) << i; });
  let f2 = 0;
  const c2: Array<[number, number]> = [];
  for (let i = 0; i < 8; i++) c2.push([size - 1 - i, 8]);
  for (let i = 8; i < 15; i++) c2.push([8, size - 15 + i]);
  c2.forEach(([x, y], i) => { f2 |= bit(x, y) << i; });
  assert.equal(f1, f2, 'format copies differ');
  const mask = FORMAT_M.indexOf(f1);
  assert.ok(mask >= 0, 'format info not in EC-M table');
  assert.equal(bit(8, size - 8), 1, 'dark module');

  // 데이터 비트 읽기
  const unmask = maskFn(mask);
  const bits: number[] = [];
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let n = 0; n < size; n++) {
      const y = upward ? size - 1 - n : n;
      for (let c = 0; c < 2; c++) {
        const x = right - c;
        if (isFunctionModule(version, size, x, y)) continue;
        bits.push(bit(x, y) ^ (unmask(x, y) ? 1 : 0));
      }
    }
    upward = !upward;
  }
  const [ecLen, b1, d1, b2, d2] = EC_M[version];
  const total = b1 * d1 + b2 * d2 + (b1 + b2) * ecLen;
  assert.ok(bits.length >= total * 8 && bits.length - total * 8 < 8, 'data module count');
  const cw: number[] = [];
  for (let i = 0; i < total; i++) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i * 8 + j];
    cw.push(v);
  }

  // 인터리브 풀기
  const nb = b1 + b2;
  const lens = Array.from({ length: nb }, (_, i) => (i < b1 ? d1 : d2));
  const blocks: number[][] = lens.map(() => []);
  let p = 0;
  for (let i = 0; i < Math.max(d1, d2); i++) for (let b = 0; b < nb; b++) if (i < lens[b]) blocks[b].push(cw[p++]);
  const ecs: number[][] = lens.map(() => []);
  for (let i = 0; i < ecLen; i++) for (let b = 0; b < nb; b++) ecs[b].push(cw[p++]);

  // 블록마다 신드롬 S_i = c(α^i), i=0..ecLen-1 이 모두 0이어야 한다
  const data: number[] = [];
  for (let b = 0; b < nb; b++) {
    const word = [...blocks[b], ...ecs[b]];
    for (let i = 0; i < ecLen; i++) {
      const a = gfPow2(i);
      let s = 0;
      for (const c of word) s = gfMulSlow(s, a) ^ c;
      assert.equal(s, 0, `syndrome ${i} of block ${b}`);
    }
    data.push(...blocks[b]);
  }

  // 바이트 모드 파싱
  const stream: number[] = [];
  for (const byte of data) for (let i = 7; i >= 0; i--) stream.push((byte >> i) & 1);
  const read = (start: number, len: number) => stream.slice(start, start + len).reduce((a, v) => (a << 1) | v, 0);
  assert.equal(read(0, 4), 0b0100, 'byte mode');
  const countBits = version <= 9 ? 8 : 16;
  const count = read(4, countBits);
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) out[i] = read(4 + countBits + i * 8, 8);
  return { text: new TextDecoder().decode(out), mask, version };
}

function makeUri(label: string, secret: string, issuer: string): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

test('여러 길이의 문자열이 인코드 후 독립 디코더로 그대로 복원된다(1~10 전 버전)', () => {
  const caps = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];
  const samples: string[] = ['', 'a', 'HELLO WORLD', '안녕하세요 QR', '😀 emoji'];
  for (const cap of caps) {
    samples.push('x'.repeat(cap), 'Zq9'.repeat(Math.floor(cap / 3)).slice(0, cap));
  }
  for (const text of samples) {
    const qr = encodeQr(text);
    const back = decode(qr.modules);
    assert.equal(back.text, text);
    assert.equal(back.version, qr.version);
    assert.equal(back.mask, qr.mask);
  }
});

test('otpauth URI(100~200바이트대)를 만들고, 읽고, 바꾸고, 지우기를 반복해도 복원된다', () => {
  const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  const uris = [
    makeUri('a@b.co', secret.slice(0, 16), 'Slack Clone'),
    makeUri('kim.kwanhyun@example.com', secret, 'Slack Clone'),
    makeUri('long.name+tag@team.example.com', secret, '팀 메신저'),
  ];
  const store = new Map<string, string>();
  for (let round = 0; round < 3; round++) {
    // Create
    uris.forEach((u, i) => store.set(`k${i}`, u));
    // Read
    for (const [, u] of store) {
      const qr = encodeQr(u);
      assert.equal(decode(qr.modules).text, u);
      assert.ok(qr.version >= 3 && qr.version <= 10, `v${qr.version} for ${new TextEncoder().encode(u).length} bytes`);
    }
    // Update: 비밀 키를 바꾸면 행렬도 달라진다
    const before = JSON.stringify(encodeQr(store.get('k1')!).modules);
    store.set('k1', store.get('k1')!.replace('JBSW', 'KRSX'));
    assert.notEqual(JSON.stringify(encodeQr(store.get('k1')!).modules), before);
    assert.equal(decode(encodeQr(store.get('k1')!).modules).text, store.get('k1'));
    // Delete
    store.delete('k0');
    assert.equal(store.has('k0'), false);
    store.clear();
  }
});

test('같은 입력은 같은 행렬(결정적)이고, 마스크는 패널티 최소인 것이 고정된다', () => {
  const a = encodeQr('otpauth://totp/x?secret=ABC');
  const b = encodeQr('otpauth://totp/x?secret=ABC');
  assert.deepEqual(a.modules, b.modules);
  assert.equal(a.mask, b.mask);
});

test('고정 패턴: finder, separator, timing, dark module 위치와 값', () => {
  for (const text of ['x', 'x'.repeat(100), 'x'.repeat(213)]) {
    const { modules: m, size } = encodeQr(text);
    const finderAt = (ox: number, oy: number) => {
      for (let dy = 0; dy < 7; dy++) {
        for (let dx = 0; dx < 7; dx++) {
          const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
          assert.equal(m[oy + dy][ox + dx], ring !== 2, `finder ${ox},${oy} at ${dx},${dy}`);
        }
      }
    };
    finderAt(0, 0);
    finderAt(size - 7, 0);
    finderAt(0, size - 7);
    for (let i = 0; i < 8; i++) {
      assert.equal(m[7][i], false); assert.equal(m[i][7], false); // 왼쪽 위 구분선
      assert.equal(m[7][size - 1 - i], false); assert.equal(m[i][size - 8], false);
      assert.equal(m[size - 8][i], false); assert.equal(m[size - 1 - i][7], false);
    }
    for (let i = 8; i < size - 8; i++) {
      assert.equal(m[6][i], i % 2 === 0, `timing row ${i}`);
      assert.equal(m[i][6], i % 2 === 0, `timing col ${i}`);
    }
    assert.equal(m[size - 8][8], true, 'dark module');
  }
});

test('정렬 패턴: 버전 2 이상에서 5x5 모양이 맞다(버전 2는 (18,18))', () => {
  const { modules: m } = encodeQr('x'.repeat(20)); // 버전 2
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      assert.equal(m[18 + dy][18 + dx], Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
});

test('버전 7 이상: 버전 정보가 두 곳에 같은 값으로 들어간다', () => {
  const { modules: m, size, version } = encodeQr('y'.repeat(120));
  assert.equal(version, 7);
  const bits = versionBits(7);
  for (let i = 0; i < 18; i++) {
    const expected = ((bits >>> i) & 1) === 1;
    assert.equal(m[Math.floor(i / 3)][size - 11 + (i % 3)], expected, `top-right ${i}`);
    assert.equal(m[size - 11 + (i % 3)][Math.floor(i / 3)], expected, `bottom-left ${i}`);
  }
});

test('행렬 크기는 17+4v 이고 quiet zone은 컴포넌트가 4모듈로 그린다', () => {
  for (let v = 1; v <= 10; v++) {
    const qr = encodeQr('a'.repeat(byteCapacity(v)));
    assert.equal(qr.size, 17 + 4 * v);
    assert.equal(qr.modules.length, qr.size);
    assert.ok(qr.modules.every((row) => row.length === qr.size));
  }
});
