// OS별 코드 서명 판정 (release.yml build job이 쓴다). 시크릿 값은 출력하지 않고 true/false만 낸다.
// - windows: WIN_CSC_LINK + WIN_CSC_KEY_PASSWORD 둘 다 있어야 서명
// - macos:   CSC_LINK + CSC_KEY_PASSWORD 둘 다 있어야 서명. 거기에 APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID까지 있으면 notarization
// - linux:   서명 없음
// 사용: node scripts/release-sign.mjs <windows|macos|linux>  (환경변수에서 읽는다)
import { pathToFileURL } from 'node:url';

const has = (env, k) => typeof env[k] === 'string' && env[k] !== '';

export function detectSigning(os, env) {
  if (os === 'windows') return { sign: has(env, 'WIN_CSC_LINK') && has(env, 'WIN_CSC_KEY_PASSWORD'), notarize: false };
  if (os === 'macos') {
    const sign = has(env, 'CSC_LINK') && has(env, 'CSC_KEY_PASSWORD');
    const notarize = sign && ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'].every((k) => has(env, k));
    return { sign, notarize };
  }
  if (os === 'linux') return { sign: false, notarize: false };
  throw new Error(`알 수 없는 OS: ${JSON.stringify(os)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const r = detectSigning(process.argv[2], process.env);
    console.log(`sign=${r.sign}\nnotarize=${r.notarize}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
