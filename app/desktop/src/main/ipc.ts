import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { DESKTOP_CHANNELS, SETUP_CHANNELS, parseBadgeCount, parseNotifyPayload, type NotifyPayload } from './ipcContract';
import { isAllowedNavigation, isSetupPageUrl, type ServerUrlError } from './policy';
import type { Messages } from './messages';

/**
 * IPC 처리. 화이트리스트 채널만 등록하고, 보낸 화면이 맞는지(메인 프레임 + origin)를 매번 확인한다.
 */

export interface SetupState {
  locale: 'en' | 'ko';
  messages: Messages;
  currentServerUrl: string | null;
  /** 직전 연결 실패 이유 (입력 화면 위에 보여 준다) */
  error: { code: ServerUrlError | 'unreachable' | 'redirected'; server: string | null } | null;
  canCancel: boolean;
}

export type SubmitResult = { ok: true } | { ok: false; error: ServerUrlError };

export interface IpcHandlers {
  getServerOrigin: () => string | null;
  notify: (payload: NotifyPayload) => void;
  setBadgeCount: (count: number) => void;
  showSetup: () => void;
  getSetupState: () => SetupState;
  submitServer: (input: string) => SubmitResult;
  resetServer: () => Promise<void>;
  cancelSetup: () => void;
}

type SenderEvent = IpcMainEvent | IpcMainInvokeEvent;

function isMainFrame(event: SenderEvent): boolean {
  const frame = event.senderFrame;
  return !!frame && frame === event.sender.mainFrame;
}

function fromServerPage(event: SenderEvent, serverOrigin: string | null): boolean {
  return isMainFrame(event) && isAllowedNavigation(event.senderFrame?.url ?? '', serverOrigin);
}

function fromSetupPage(event: SenderEvent): boolean {
  return isMainFrame(event) && isSetupPageUrl(event.senderFrame?.url ?? '');
}

export function registerIpc(handlers: IpcHandlers): void {
  // 서버 페이지 → main
  ipcMain.on(DESKTOP_CHANNELS.notify, (event, raw: unknown) => {
    if (!fromServerPage(event, handlers.getServerOrigin())) return;
    const payload = parseNotifyPayload(raw);
    if (payload) handlers.notify(payload);
  });

  ipcMain.on(DESKTOP_CHANNELS.setBadge, (event, raw: unknown) => {
    if (!fromServerPage(event, handlers.getServerOrigin())) return;
    const count = parseBadgeCount(raw);
    if (count !== null) handlers.setBadgeCount(count);
  });

  ipcMain.on(DESKTOP_CHANNELS.changeServer, (event) => {
    if (!fromServerPage(event, handlers.getServerOrigin())) return;
    handlers.showSetup();
  });

  // 서버 주소 입력 화면 → main
  ipcMain.handle(SETUP_CHANNELS.getState, (event) => {
    if (!fromSetupPage(event)) throw new Error('forbidden');
    return handlers.getSetupState();
  });

  ipcMain.handle(SETUP_CHANNELS.submit, (event, raw: unknown) => {
    if (!fromSetupPage(event)) throw new Error('forbidden');
    if (typeof raw !== 'string') return { ok: false, error: 'invalid' } satisfies SubmitResult;
    return handlers.submitServer(raw);
  });

  ipcMain.handle(SETUP_CHANNELS.reset, async (event) => {
    if (!fromSetupPage(event)) throw new Error('forbidden');
    await handlers.resetServer();
    return handlers.getSetupState();
  });

  ipcMain.on(SETUP_CHANNELS.cancel, (event) => {
    if (!fromSetupPage(event)) return;
    handlers.cancelSetup();
  });
}
