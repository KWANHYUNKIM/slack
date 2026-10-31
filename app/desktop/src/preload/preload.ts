/**
 * preload (sandbox). contextBridge로 꼭 필요한 함수만 노출한다. ipcRenderer 자체는 넘기지 않는다.
 * - 서버 페이지: window.desktop (알림, 배지, 서버 변경, 알림 클릭 시 이동)
 * - 서버 주소 입력 화면(app://setup): window.setupApi
 * sandbox preload는 'electron' 말고 다른 파일을 require하지 못해서 채널 이름을 여기에 다시 적는다.
 * main/ipcContract.ts와 같아야 한다 (ipcContract.test.ts가 검사).
 * 실제 권한 검사(보낸 화면의 origin, 인자 검증)는 main에서 다시 한다.
 */
import electron = require('electron');

const { contextBridge, ipcRenderer } = electron;

const CHANNELS = {
  notify: 'desktop:notify',
  setBadge: 'desktop:set-badge',
  changeServer: 'desktop:change-server',
  navigate: 'desktop:navigate',
  setupGetState: 'setup:get-state',
  setupSubmit: 'setup:submit',
  setupReset: 'setup:reset',
  setupCancel: 'setup:cancel',
} as const;

/** window.desktop의 버전. 프런트는 이 값으로 기능 유무를 판단한다. */
const API_VERSION = 1;

const isSetupPage = window.location.protocol === 'app:' && window.location.host === 'setup';

if (isSetupPage) {
  contextBridge.exposeInMainWorld('setupApi', {
    getState: (): Promise<unknown> => ipcRenderer.invoke(CHANNELS.setupGetState),
    submit: (serverUrl: string): Promise<unknown> => ipcRenderer.invoke(CHANNELS.setupSubmit, String(serverUrl)),
    reset: (): Promise<unknown> => ipcRenderer.invoke(CHANNELS.setupReset),
    cancel: (): void => ipcRenderer.send(CHANNELS.setupCancel),
  });
} else {
  contextBridge.exposeInMainWorld('desktop', {
    apiVersion: API_VERSION,
    platform: process.platform,
    notify: (payload: { title: string; body?: string; path?: string | null }): void => {
      // 함수, 프로토타입 같은 것이 섞여 넘어가지 않도록 필요한 필드만 복사한다
      ipcRenderer.send(CHANNELS.notify, {
        title: payload?.title,
        body: payload?.body,
        path: payload?.path,
      });
    },
    setBadgeCount: (count: number): void => {
      ipcRenderer.send(CHANNELS.setBadge, count);
    },
    changeServer: (): void => {
      ipcRenderer.send(CHANNELS.changeServer);
    },
    /** 알림을 눌렀을 때 이동할 경로를 받는다. 해제 함수를 돌려준다. */
    onNavigate: (callback: (path: string) => void): (() => void) => {
      const listener = (_event: unknown, path: unknown) => {
        if (typeof path === 'string') callback(path);
      };
      ipcRenderer.on(CHANNELS.navigate, listener);
      return () => {
        ipcRenderer.removeListener(CHANNELS.navigate, listener);
      };
    },
  });
}
