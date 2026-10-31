#!/usr/bin/env bash
# 릴리스 게시 (release.yml publish job). draft로 만들고 → 파일을 올리고 → 마지막에 공개한다.
# 업로드가 하나라도 실패하면(set -e) 공개하지 않아서 반쪽짜리 릴리스가 보이지 않는다.
# 환경변수: RELEASE_TAG, PRERELEASE(true|false), GITHUB_REPOSITORY, GH_TOKEN(워크플로의 GITHUB_TOKEN)
# 인자: 올릴 파일들
set -euo pipefail
: "${RELEASE_TAG:?}" "${GITHUB_REPOSITORY:?}"
[ "$#" -gt 0 ] || { echo "올릴 파일이 없다" >&2; exit 1; }

# release-please 경로에서는 draft 릴리스가 이미 있다. 태그를 직접 푸시한 경로에서는 여기서 draft로 만든다.
if ! gh release view "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
  flags=(--draft --verify-tag --title "$RELEASE_TAG" --generate-notes)
  if [ "${PRERELEASE:-false}" = true ]; then flags+=(--prerelease); fi
  gh release create "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" "${flags[@]}"
fi

gh release upload "$RELEASE_TAG" "$@" --repo "$GITHUB_REPOSITORY" --clobber
gh release edit "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --draft=false
