// 릴리스 태그 검증 (release.yml의 prepare job이 쓴다).
// - 태그가 SemVer 2.0(vMAJOR.MINOR.PATCH[-prerelease])인지 확인한다. `v*` 글롭은 `vfoo`도 잡으므로 여기서 거른다.
//   prerelease의 숫자 식별자는 앞자리 0을 금지한다(1.0.0-01은 무효). 영문 식별자는 [0-9A-Za-z-]다.
//   build metadata(+build)는 받지 않는다: 파일 이름과 URL에 `+`가 들어가고, 릴리스 버전은 커밋 기록으로만 정하기 때문이다.
// - 태그의 버전이 app/desktop/package.json의 version과 같은지 확인한다.
//   electron-builder는 package.json의 version으로 파일 이름을 만들기 때문에 둘이 다르면 릴리스가 어긋난다.
// 사용: node scripts/release-tag.mjs <tag> <package.json 경로>  → stdout에 key=value 줄(워크플로의 job output 파일에 그대로 추가)
// docs/conventions/git.md 5절, docs/architecture/enterprise-and-distribution.md 2절
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const NUM = '(?:0|[1-9]\\d*)';
// prerelease 식별자: 앞자리 0 없는 숫자, 또는 영문/하이픈을 하나 이상 포함한 영숫자
const PRE_ID = `(?:${NUM}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
const TAG_RE = new RegExp(`^v(${NUM})\\.(${NUM})\\.(${NUM})(?:-(${PRE_ID}(?:\\.${PRE_ID})*))?$`);

/** 태그를 해석한다. 형식이 틀리면 Error를 던진다. */
export function parseTag(tag) {
  const m = typeof tag === 'string' ? TAG_RE.exec(tag) : null;
  if (!m) throw new Error(`릴리스 태그 형식이 아니다: ${JSON.stringify(tag)} (예: v1.2.3, v1.2.3-rc.1)`);
  const prerelease = m[4] ?? '';
  return {
    tag,
    version: `${m[1]}.${m[2]}.${m[3]}${prerelease ? `-${prerelease}` : ''}`,
    prerelease: prerelease !== '',
  };
}

/** 태그 버전과 package.json 버전이 같아야 한다. */
export function checkTag(tag, packageVersion) {
  const parsed = parseTag(tag);
  if (parsed.version !== packageVersion) {
    throw new Error(`태그 버전(${parsed.version})과 package.json 버전(${packageVersion})이 다르다`);
  }
  return parsed;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const [tag, pkgPath] = process.argv.slice(2);
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const r = checkTag(tag, pkg.version);
    console.log(`tag=${r.tag}\nversion=${r.version}\nprerelease=${r.prerelease}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
