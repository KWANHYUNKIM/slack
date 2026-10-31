import fs from 'node:fs';
import path from 'node:path';
import { normalizeServerUrl, type ServerUrlError } from './policy';

/**
 * 서버 주소 저장소. userData/settings.json에 origin 하나만 둔다.
 * electron을 import하지 않아 node --test로 검사한다 (파일 경로는 호출자가 넘긴다).
 */

export interface DesktopSettings {
  version: 1;
  serverUrl: string | null;
}

const DEFAULT_SETTINGS: DesktopSettings = { version: 1, serverUrl: null };

export type SaveResult = { ok: true; serverUrl: string } | { ok: false; error: ServerUrlError };

export interface SettingsStore {
  /** 저장한 서버 origin (없으면 null) */
  getServerUrl(): string | null;
  /** 입력을 검증·정규화해 저장한다. 틀리면 기존 값을 건드리지 않는다. */
  setServerUrl(input: unknown): SaveResult;
  /** 저장한 서버 주소를 지운다 */
  clearServerUrl(): void;
}

/** 깨졌거나 손으로 고친 파일도 안전하게 읽는다: 저장값을 다시 검증해 틀리면 기본값 */
export function parseSettings(text: string): DesktopSettings {
  try {
    const raw = JSON.parse(text) as Partial<DesktopSettings> | null;
    if (!raw || typeof raw !== 'object' || raw.version !== 1) return { ...DEFAULT_SETTINGS };
    if (raw.serverUrl == null) return { ...DEFAULT_SETTINGS };
    const normalized = normalizeServerUrl(raw.serverUrl);
    // origin이 아니라 경로까지 붙은 값이 들어 있으면 버린다(허용 origin은 정확히 하나)
    if (!normalized.ok || normalized.origin !== raw.serverUrl) return { ...DEFAULT_SETTINGS };
    return { version: 1, serverUrl: normalized.origin };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function readSettings(filePath: string): DesktopSettings {
  try {
    return parseSettings(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** 임시 파일에 쓰고 rename해서 중간에 꺼져도 파일이 반쯤 써지지 않게 한다 */
function writeSettings(filePath: string, settings: DesktopSettings): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

/** 파일은 처음 한 번만 읽고 메모리에 둔다(이동·권한 검사마다 불리므로). 쓰기는 파일과 메모리를 함께 바꾼다. */
export function createSettingsStore(filePath: string): SettingsStore {
  let cached: DesktopSettings | null = null;
  const current = () => (cached ??= readSettings(filePath));
  return {
    getServerUrl() {
      return current().serverUrl;
    },
    setServerUrl(input) {
      const result = normalizeServerUrl(input);
      if (!result.ok) return result;
      const next: DesktopSettings = { version: 1, serverUrl: result.origin };
      writeSettings(filePath, next);
      cached = next;
      return { ok: true, serverUrl: result.origin };
    },
    clearServerUrl() {
      const next: DesktopSettings = { ...DEFAULT_SETTINGS };
      writeSettings(filePath, next);
      cached = next;
    },
  };
}
