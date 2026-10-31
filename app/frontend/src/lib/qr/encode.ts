// QR 코드 인코더(ISO/IEC 18004): 바이트 모드, 오류 정정 M, 버전 1~10 자동 선택.
// 외부 QR 서비스·라이브러리 없이 직접 구현한다(규칙 17). 2FA 설정용 otpauth URI(약 100~200바이트)를 담는 것이 목적이다.

export interface QrMatrix {
  version: number;
  size: number;
  /** modules[y][x], true가 검은 모듈 */
  modules: boolean[][];
  mask: number;
}

// 오류 정정 M 레벨 표: [블록당 EC 코드워드 수, 그룹1 블록 수, 그룹1 데이터 코드워드, 그룹2 블록 수, 그룹2 데이터 코드워드]
const EC_M: Record<number, [number, number, number, number, number]> = {
  1: [10, 1, 16, 0, 0],
  2: [16, 1, 28, 0, 0],
  3: [26, 1, 44, 0, 0],
  4: [18, 2, 32, 0, 0],
  5: [24, 2, 43, 0, 0],
  6: [16, 4, 27, 0, 0],
  7: [18, 4, 31, 0, 0],
  8: [22, 2, 38, 2, 39],
  9: [22, 3, 36, 2, 37],
  10: [26, 4, 43, 1, 44],
};

const ALIGNMENT: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

export const MAX_VERSION = 10;

/** 버전의 데이터 코드워드 수 */
export function dataCodewords(version: number): number {
  const [, b1, d1, b2, d2] = EC_M[version];
  return b1 * d1 + b2 * d2;
}

/** 바이트 모드, EC M에서 담을 수 있는 최대 바이트 수 */
export function byteCapacity(version: number): number {
  const countBits = version <= 9 ? 8 : 16;
  return Math.floor((dataCodewords(version) * 8 - 4 - countBits) / 8);
}

// ---- GF(256) 위의 리드-솔로몬 (원시 다항식 0x11D) ----
const EXP = new Array<number>(512);
const LOG = new Array<number>(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

function gfMul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
}

/** 생성 다항식 계수(최고차항 1 제외). (x-α^0)(x-α^1)...(x-α^(n-1)) */
export function rsGenerator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly.slice(1);
}

/** 데이터 다항식을 생성 다항식으로 나눈 나머지 = EC 코드워드 */
export function rsEncode(data: number[], ecLen: number): number[] {
  const gen = rsGenerator(ecLen);
  const rem = new Array<number>(ecLen).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem.shift()!;
    rem.push(0);
    for (let i = 0; i < ecLen; i++) rem[i] ^= gfMul(gen[i], factor);
  }
  return rem;
}

// ---- 형식·버전 정보 (BCH) ----
/** EC M(비트 00) + 마스크 번호 → 15비트 형식 정보 */
export function formatBits(mask: number): number {
  const data = mask; // M = 00
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** 버전 7 이상의 18비트 버전 정보 */
export function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

// ---- 데이터 코드워드 만들기 ----
/** 모드·길이·데이터·패딩 → 블록 분할 → EC 추가 → 인터리브까지 끝낸 코드워드 열 */
export function buildCodewords(bytes: Uint8Array, version: number): number[] {
  const bits: number[] = [];
  const push = (value: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4); // 바이트 모드
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  const capacityBits = dataCodewords(version) * 8;
  push(0, Math.min(4, capacityBits - bits.length)); // 종결자
  while (bits.length % 8 !== 0) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    data.push(v);
  }
  for (let pad = 0xec; data.length < dataCodewords(version); pad ^= 0xec ^ 0x11) data.push(pad);

  const [ecLen, b1, d1, b2, d2] = EC_M[version];
  const dataBlocks: number[][] = [];
  let offset = 0;
  for (let i = 0; i < b1 + b2; i++) {
    const len = i < b1 ? d1 : d2;
    dataBlocks.push(data.slice(offset, offset + len));
    offset += len;
  }
  const ecBlocks = dataBlocks.map((block) => rsEncode(block, ecLen));
  const out: number[] = [];
  const maxData = Math.max(d1, d2);
  for (let i = 0; i < maxData; i++) for (const block of dataBlocks) if (i < block.length) out.push(block[i]);
  for (let i = 0; i < ecLen; i++) for (const block of ecBlocks) out.push(block[i]);
  return out;
}

// ---- 행렬 ----
export function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function newGrid(size: number): boolean[][] {
  return Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
}

/** 패널티 점수(규칙 N1~N4) */
export function penalty(m: boolean[][]): number {
  const size = m.length;
  let score = 0;
  const lineScore = (line: boolean[]) => {
    let s = 0;
    let run = 1;
    for (let i = 1; i <= line.length; i++) {
      if (i < line.length && line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) s += 3 + (run - 5); // N1
        run = 1;
      }
    }
    // N3: 1:1:3:1:1 파인더 모양 앞이나 뒤에 밝은 4칸
    const pat = [true, false, true, true, true, false, true];
    for (let i = 0; i + 7 <= line.length; i++) {
      if (!pat.every((v, k) => line[i + k] === v)) continue;
      if (i >= 4 && [1, 2, 3, 4].every((k) => !line[i - k])) s += 40;
      if (i + 11 <= line.length && [7, 8, 9, 10].every((k) => !line[i + k])) s += 40;
    }
    return s;
  };
  for (let y = 0; y < size; y++) score += lineScore(m[y]);
  for (let x = 0; x < size; x++) score += lineScore(m.map((row) => row[x]));
  // N2: 2x2 같은 색 블록
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = m[y][x];
      if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
    }
  }
  // N4: 검은 모듈 비율
  let dark = 0;
  for (const row of m) for (const v of row) if (v) dark++;
  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return score;
}

/** 문자열(UTF-8 바이트)을 QR 행렬로 만든다. 버전 10(M)에 안 들어가면 RangeError. */
export function encodeQr(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  let version = 0;
  for (let v = 1; v <= MAX_VERSION; v++) {
    if (bytes.length <= byteCapacity(v)) { version = v; break; }
  }
  if (!version) throw new RangeError(`QR payload too long: ${bytes.length} bytes`);

  const size = 17 + 4 * version;
  const base = newGrid(size);
  const fn = newGrid(size); // 기능 패턴(데이터가 들어가지 않는 칸)
  const setFn = (x: number, y: number, dark: boolean) => {
    base[y][x] = dark;
    fn[y][x] = true;
  };

  // 타이밍
  for (let i = 0; i < size; i++) {
    setFn(6, i, i % 2 === 0);
    setFn(i, 6, i % 2 === 0);
  }
  // 파인더 + 구분선
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        setFn(x, y, dist !== 2 && dist !== 4);
      }
    }
  }
  // 정렬 패턴(파인더와 겹치는 세 곳 제외)
  const pos = ALIGNMENT[version];
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setFn(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }
  // 형식 정보(복사본 2개)와 어두운 모듈. 마스크마다 다시 쓴다.
  const drawFormat = (grid: boolean[][], mask: number) => {
    const bits = formatBits(mask);
    const put = (x: number, y: number, i: number) => { grid[y][x] = ((bits >>> i) & 1) !== 0; fn[y][x] = true; };
    for (let i = 0; i <= 5; i++) put(8, i, i);
    put(8, 7, 6);
    put(8, 8, 7);
    put(7, 8, 8);
    for (let i = 9; i < 15; i++) put(14 - i, 8, i);
    for (let i = 0; i < 8; i++) put(size - 1 - i, 8, i);
    for (let i = 8; i < 15; i++) put(8, size - 15 + i, i);
    grid[size - 8][8] = true;
    fn[size - 8][8] = true;
  };
  drawFormat(base, 0);
  // 버전 정보(7 이상)
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFn(a, b, dark);
      setFn(b, a, dark);
    }
  }

  // 데이터 배치(오른쪽 아래에서 두 열씩 지그재그, 6번 열은 건너뜀)
  const dataBits: boolean[] = [];
  for (const cw of buildCodewords(bytes, version)) for (let i = 7; i >= 0; i--) dataBits.push(((cw >>> i) & 1) !== 0);
  let k = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let n = 0; n < size; n++) {
      const y = upward ? size - 1 - n : n;
      for (let c = 0; c < 2; c++) {
        const x = right - c;
        if (fn[y][x]) continue;
        base[y][x] = k < dataBits.length ? dataBits[k] : false; // 남는 칸(나머지 비트)은 밝게
        k++;
      }
    }
    upward = !upward;
  }

  // 마스크 8종 중 패널티가 가장 낮은 것
  let best = base;
  let bestMask = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const grid = base.map((row) => row.slice());
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!fn[y][x] && maskBit(mask, x, y)) grid[y][x] = !grid[y][x];
      }
    }
    drawFormat(grid, mask);
    const score = penalty(grid);
    if (score < bestScore) { bestScore = score; best = grid; bestMask = mask; }
  }
  return { version, size, modules: best, mask: bestMask };
}
