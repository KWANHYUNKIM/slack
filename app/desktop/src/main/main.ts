import path from 'node:path';
import fs from 'node:fs/promises';
import { app, BrowserWindow, Menu, Notification, protocol, session, type MenuItemConstructorOptions } from 'electron';
import { registerIpc, type SetupState } from './ipc';
import { DESKTOP_EVENTS } from './ipcContract';
import { MESSAGES, format, pickLocale, type MessageKey } from './messages';
import { SETUP_SCHEME, SETUP_URL, resolveSetupAsset, originOf } from './policy';
import { hardenSession, hardenWebContents } from './security';
import { createSettingsStore } from './settings';

/**
 * 데스크톱 셸 진입점. 설치 파일에는 서버가 없고, 저장한 서버 주소의 웹 앱을 띄운다.
 * 구조: docs/architecture/enterprise-and-distribution.md 1절, 보안: docs/security/nodejs-security.md 9절
 */

// 모든 렌더러를 sandbox로 띄운다 (webPreferences.sandbox와 함께 이중으로)
app.enableSandbox();

// 서버 주소 입력 화면은 file:// 대신 앱 내부 스킴으로 띄운다 (standard + secure → origin과 CSP 'self'가 정상 동작)
protocol.registerSchemesAsPrivileged([
  { scheme: SETUP_SCHEME, privileges: { standard: true, secure: true } },
]);

const SETUP_DIR = path.join(__dirname, '..', 'setup');
const PRELOAD_PATH = path.join(__dirname, '..', 'preload', 'preload.js');
const SETUP_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

let mainWindow: BrowserWindow | null = null;
let setupError: SetupState['error'] = null;
let settings: ReturnType<typeof createSettingsStore>;

const locale = () => pickLocale(app.getPreferredSystemLanguages().concat(app.getLocale()));
const t = (key: MessageKey, params?: Record<string, string>) => format(MESSAGES[locale()][key], params);
const getServerOrigin = () => settings.getServerUrl();

function registerSetupProtocol(): void {
  protocol.handle(SETUP_SCHEME, async (request) => {
    const file = resolveSetupAsset(request.url);
    if (!file) return new Response('Not found', { status: 404 });
    const body = await fs.readFile(path.join(SETUP_DIR, file));
    return new Response(body, {
      headers: {
        'Content-Type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
        'Content-Security-Policy': SETUP_CSP,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });
}

function showSetup(error: SetupState['error'] = null): void {
  setupError = error;
  mainWindow?.loadURL(SETUP_URL).catch(() => {});
}

function loadServer(): void {
  const server = getServerOrigin();
  if (!server) {
    showSetup();
    return;
  }
  setupError = null;
  mainWindow?.loadURL(server).catch(() => {
    // 실패 처리는 did-fail-load에서 한다
  });
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const workspaceMenu: MenuItemConstructorOptions = {
    label: t('menu.workspace'),
    submenu: [{ label: t('menu.changeServer'), click: () => showSetup() }],
  };
  // 역할(role) 메뉴는 Electron이 이름과 단축키(복사·붙여넣기 등)를 붙인다
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : [{ role: 'fileMenu' } as MenuItemConstructorOptions]),
    { role: 'editMenu' },
    workspaceMenu,
    {
      role: 'viewMenu',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' } as MenuItemConstructorOptions]),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 480,
    minHeight: 400,
    show: false,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: true,
      devTools: !app.isPackaged,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 서버에 못 붙으면 입력 화면으로 돌아가 이유를 보여 준다 (-3 ERR_ABORTED는 우리가 막은 이동이라 무시)
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, _desc, validatedUrl, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    if (originOf(validatedUrl) !== getServerOrigin()) return;
    showSetup({ code: 'unreachable', server: getServerOrigin() });
  });

  loadServer();
}

function showNotification(title: string, body: string, inAppPath: string | null): void {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body });
  notification.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    if (inAppPath) mainWindow.webContents.send(DESKTOP_EVENTS.navigate, inAppPath);
  });
  notification.show();
}

function setBadgeCount(count: number): void {
  // macOS 독, Linux(Unity) 배지. Windows는 지원하지 않으면 false를 돌려준다(오버레이 아이콘은 남은 이슈)
  app.setBadgeCount(count);
}

function getSetupState(): SetupState {
  const current = locale();
  return {
    locale: current,
    messages: MESSAGES[current],
    currentServerUrl: getServerOrigin(),
    error: setupError,
    canCancel: !!getServerOrigin(),
  };
}

async function resetServer(): Promise<void> {
  const previous = getServerOrigin();
  settings.clearServerUrl();
  setupError = null;
  app.setBadgeCount(0);
  // 지운 서버의 로그인 토큰(localStorage), 쿠키, 캐시도 함께 지운다
  if (previous) await session.defaultSession.clearStorageData({ origin: previous }).catch(() => {});
}

// 같은 앱을 두 번 띄우면 기존 창을 앞으로 가져온다
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on('web-contents-created', (_event, contents) => {
    hardenWebContents(contents, {
      getServerOrigin,
      onBlockedRedirect: (blocked) => {
        if (blocked === mainWindow?.webContents) showSetup({ code: 'redirected', server: getServerOrigin() });
      },
    });
  });

  app.whenReady().then(() => {
    // Windows 알림이 앱 이름으로 뜨게 한다 (electron-builder appId와 같아야 한다)
    if (process.platform === 'win32') app.setAppUserModelId('com.slackclone.desktop');
    settings = createSettingsStore(path.join(app.getPath('userData'), 'settings.json'));
    hardenSession(session.defaultSession, getServerOrigin);
    registerSetupProtocol();
    registerIpc({
      getServerOrigin,
      notify: ({ title, body, path: inAppPath }) => showNotification(title, body, inAppPath),
      setBadgeCount,
      showSetup: () => showSetup(),
      getSetupState,
      submitServer: (input) => {
        const result = settings.setServerUrl(input);
        if (!result.ok) return result;
        loadServer();
        return { ok: true };
      },
      resetServer,
      cancelSetup: () => {
        if (getServerOrigin()) loadServer();
      },
    });
    buildMenu();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
