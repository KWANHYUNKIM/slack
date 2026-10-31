# 프런트엔드 규칙 (app/frontend)

스택: React 19 · TypeScript(strict) · Vite · Tailwind CSS · Zustand · React Router 7 · Quill 2 · socket.io-client · Playwright(E2E)

## 1. 폴더 구조
```
src/
  components/<영역>/<컴포넌트>.tsx   Layout, Sidebar, Messages, Huddle, Admin, Auth ...
  components/ui/                     버튼, 모달 같은 공용 UI (class-variance-authority + tailwind-merge)
  stores/use<도메인>Store.ts         Zustand 스토어 (서버 상태 캐시 + UI 상태)
  hooks/use<기능>.ts                 컴포넌트 로직 재사용
  lib/api.ts                         HTTP 호출은 여기를 통해서만
  lib/socket.ts                      소켓 연결과 이벤트 구독은 여기를 통해서만
  lib/types.ts                       백엔드 응답 타입
tests/<기능>.spec.ts                 Playwright E2E
```

## 2. 코드 규칙
- 컴포넌트는 함수형만 쓴다. 파일 하나에 export하는 컴포넌트는 하나, 파일 이름은 PascalCase로 한다.
- 300줄을 넘는 컴포넌트는 하위 컴포넌트나 훅으로 나눈다.
- 서버 데이터는 스토어에 둔다. 컴포넌트에서 `fetch`를 직접 부르지 말고, 스토어 액션이 `lib/api.ts`를 부르게 한다.
- 소켓 이벤트 구독은 스토어(또는 `lib/socket.ts`)에서 한다. 컴포넌트마다 `socket.on`을 흩어 두지 않는다.
- **낙관적 업데이트**: 메시지 전송, 리액션처럼 자주 쓰는 동작은 화면에 먼저 반영한다. 서버 응답이나 소켓 이벤트가 오면 확정하고, 실패하면 되돌리고 에러를 보여 준다.
- **재연결 복구**: 소켓이 다시 연결되면 열려 있는 채널의 마지막 메시지 이후를 다시 요청해서 빈 구간을 채운다.
- 스타일은 Tailwind 유틸리티로만 한다. 색과 간격은 `tailwind.config` 토큰을 쓰고 임의 값(`[13px]`)은 피한다. Slack 로고, 아이콘, 고유 색상은 쓰지 않는다.
- 접근성: 버튼에는 `aria-label`을 붙이고, 키보드만으로 조작할 수 있게 한다(포커스 이동, Esc로 닫기).
- 이름 규칙: 컴포넌트는 PascalCase, 훅은 `useXxx`, 스토어는 `useXxxStore`, 이벤트 핸들러는 `handleXxx`, props 콜백은 `onXxx`

## 3. 보안
- 사용자 콘텐츠는 `lib/renderMessageContent.tsx`로만 렌더링한다. `dangerouslySetInnerHTML`은 금지하고, 꼭 필요하면 DOMPurify로 정제하고 리뷰에서 따로 짚는다.
- 링크에는 `rel="noopener noreferrer"`를 붙이고, `javascript:` 스킴은 막는다.
- 토큰은 현재 `localStorage`에 저장한다(slawk 방식). XSS가 나면 토큰이 털리므로 XSS 방지가 최우선이다. 장기적으로 httpOnly 쿠키로 옮길지는 보안 문서 5절을 따른다.
- **데스크톱(Electron) 겸용**: 브라우저 전용 API를 바로 쓰지 말고 `window.desktop?.xxx`가 있으면 데스크톱 기능을, 없으면 웹 기능을 쓴다(알림, 배지 숫자, 딥링크).

## 4. 테스트
- 기능을 추가하면 Playwright E2E로 **CRUD 흐름**(만들기, 화면 확인, 수정, 삭제, 삭제 후 사라짐)을 하나 이상 남긴다.
- 실행: `cd app/frontend && npx playwright test tests/<파일>` (메모리를 많이 쓰니 감속 단계에서는 해당 파일만 실행)
- 빌드 확인: `npm run build`, 린트: `npm run lint`
