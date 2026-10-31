// 번역 파일 한 로캘을 en(원문)과 비교하는 규칙 (docs/architecture/i18n.md 3절).
// 파일 입출력 없이 객체만 받으므로 node --test에서 픽스처로 직접 검증한다.
import { icuArgs, icuTags } from './icu-args.mjs';

/** 중첩 JSON을 "ns:a.b.c" 형태의 평평한 맵으로 바꾼다 */
export function flattenNamespaces(namespaces) {
  const out = {};
  for (const [ns, obj] of Object.entries(namespaces)) {
    for (const [k, v] of Object.entries(flatten(obj))) out[`${ns}:${k}`] = v;
  }
  return out;
}

export function flatten(obj, prefix = '') {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') Object.assign(out, flatten(value, path));
    else out[path] = value;
  }
  return out;
}

// 실패하지 않고 문자열로만 비교하도록 파싱 오류도 값으로 돌린다
function safe(fn, text) {
  try {
    return fn(text);
  } catch (err) {
    return `파싱 오류: ${err.message}`;
  }
}

/**
 * base(en)와 data(로캘)를 비교한다. 둘 다 flattenNamespaces 결과다.
 * tier 1: 누락 키가 있으면 오류(실패).
 * tier 2: 누락 키는 경고만 한다. 화면에서는 en으로 대체된다.
 * 어느 등급이든 실패: 빈 값, en에 없는 키, '{{' 사용, ICU 인자 불일치, Trans 태그 불일치.
 */
export function checkLocale(base, data, { tier }) {
  const errors = [];
  const warnings = [];
  const missing = (msg) => (tier === 1 ? errors : warnings).push(msg);

  // i18next 보간 문법 {{name}}만 막는다. ICU select 분기의 {{name} he} 같은 형태는 허용한다.
  const I18NEXT_INTERPOLATION = /\{\{\s*[\w.]+\s*\}\}/;
  for (const key of Object.keys(base)) {
    if (I18NEXT_INTERPOLATION.test(String(base[key]))) {
      errors.push(`'{{' 사용 금지(ICU는 {name}): ${key} (en)`);
    }
  }
  for (const key of Object.keys(base)) {
    if (!(key in data)) {
      missing(`누락: ${key}`);
      continue;
    }
    const value = String(data[key]);
    if (value.trim() === '') errors.push(`빈 값: ${key}`);
    else if (I18NEXT_INTERPOLATION.test(value)) errors.push(`'{{' 사용 금지(ICU는 {name}): ${key}`);
    else if (safe(icuArgs, base[key]) !== safe(icuArgs, value)) {
      errors.push(
        `인자 불일치: ${key} (en={${safe(icuArgs, base[key])}} 번역={${safe(icuArgs, value)}})`,
      );
    } else if (safe(icuTags, base[key]) !== safe(icuTags, value)) {
      errors.push(
        `태그 불일치: ${key} (en=<${safe(icuTags, base[key])}> 번역=<${safe(icuTags, value)}>)`,
      );
    }
  }
  for (const key of Object.keys(data)) {
    if (!(key in base)) errors.push(`en에 없는 키: ${key}`);
  }
  return { errors, warnings };
}
