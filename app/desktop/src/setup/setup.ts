/**
 * 서버 주소 입력 화면 스크립트 (app://setup, sandbox 렌더러).
 * 모듈이 아니라 일반 스크립트로 컴파일된다: import/export를 쓰지 않는다.
 * 문구는 main이 고른 로캘(en/ko)의 번역을 받아 채운다. innerHTML은 쓰지 않는다.
 */

type SetupPageErrorCode =
  | 'empty'
  | 'invalid'
  | 'scheme'
  | 'credentials'
  | 'insecure'
  | 'unreachable'
  | 'redirected'
  | 'timeout';

interface SetupPageState {
  locale: string;
  messages: Record<string, string>;
  currentServerUrl: string | null;
  connectingTo: string | null;
  error: { code: SetupPageErrorCode; server: string | null } | null;
  canCancel: boolean;
}

interface Window {
  setupApi?: {
    getState(): Promise<SetupPageState>;
    submit(serverUrl: string): Promise<{ ok: true } | { ok: false; error: SetupPageErrorCode }>;
    reset(): Promise<SetupPageState>;
    cancel(): void;
  };
}

function setupPageMain(): void {
  const api = window.setupApi;
  if (!api) return;

  const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const form = byId<HTMLFormElement>('form');
  const input = byId<HTMLInputElement>('server');
  const errorEl = byId<HTMLParagraphElement>('error');
  const submitBtn = byId<HTMLButtonElement>('submit');
  const cancelBtn = byId<HTMLButtonElement>('cancel');
  const resetBtn = byId<HTMLButtonElement>('reset');
  const currentEl = byId<HTMLParagraphElement>('current');
  const connectingEl = byId<HTMLParagraphElement>('connecting');
  let messages: Record<string, string> = {};

  const tr = (key: string, params: Record<string, string> = {}) =>
    (messages[key] ?? key).replace(/\{(\w+)\}/g, (m, name: string) => params[name] ?? m);

  function showError(code: SetupPageErrorCode | null, server: string | null = null): void {
    errorEl.hidden = !code;
    errorEl.textContent = code ? tr(`setup.error.${code}`, { server: server ?? '' }) : '';
    input.setAttribute('aria-invalid', code ? 'true' : 'false');
  }

  function render(state: SetupPageState): void {
    messages = state.messages;
    document.documentElement.lang = state.locale;
    document.title = tr('setup.title');
    byId('title').textContent = tr('setup.title');
    byId('description').textContent = tr('setup.description');
    byId('label').textContent = tr('setup.label');
    byId('hint').textContent = tr('setup.hint');
    input.placeholder = tr('setup.placeholder');
    submitBtn.textContent = tr('setup.submit');
    cancelBtn.textContent = tr('setup.cancel');
    resetBtn.textContent = tr('setup.reset');

    // 연결 중: 입력 칸 대신 "연결 중" 문구와 취소 버튼만 보여 준다
    const connecting = !!state.connectingTo;
    document.body.classList.toggle('is-connecting', connecting);
    connectingEl.hidden = !connecting;
    connectingEl.textContent = connecting ? tr('setup.connecting', { server: state.connectingTo ?? '' }) : '';
    input.disabled = connecting;
    submitBtn.hidden = connecting;
    cancelBtn.hidden = !state.canCancel && !connecting;
    resetBtn.hidden = connecting || !state.currentServerUrl;
    currentEl.hidden = !state.currentServerUrl;
    currentEl.textContent = state.currentServerUrl ? tr('setup.current', { server: state.currentServerUrl }) : '';
    if (!input.value && state.currentServerUrl) input.value = state.currentServerUrl;
    showError(state.error?.code ?? null, state.error?.server ?? null);
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submitBtn.disabled = true;
    api
      .submit(input.value)
      .then((result) => {
        if (!result.ok) showError(result.error);
      })
      .finally(() => {
        submitBtn.disabled = false;
      });
  });

  cancelBtn.addEventListener('click', () => api.cancel());

  resetBtn.addEventListener('click', () => {
    input.value = '';
    api.reset().then(render).catch(() => {});
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !cancelBtn.hidden) api.cancel();
  });

  api.getState().then(render).catch(() => {});
}

setupPageMain();
