import { app, BrowserWindow, nativeTheme, shell } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { registerIpc } from './main/ipc';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    // §6.1 的三栏最窄需要 240(会话) + 320(时间线) + 320(详情) = 880
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 560,
    // 不用 show:false + ready-to-show —— 实测该事件在本项目里不稳定触发，
    // 窗口会一直不出现。backgroundColor 已经足够消除白闪。
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d1117' : '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // ↓ SPEC §9 硬约束，不可放宽。渲染进程拿不到 fs / path / require，
      //   只能通过 preload 暴露的窄接口（§7.3）向主进程要数据。
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // 本项目不嵌任何外部内容
      webviewTag: false,
      spellcheck: false,
    },
  });

  // §9「完全不联网」的兜底：渲染进程无论如何都不能把窗口导航到别处。
  // rollout 里可能有密钥，任何外发路径都要堵死。
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL;
    if (!devUrl || !url.startsWith(devUrl)) {
      event.preventDefault();
    }
  });

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[unroll] LOAD FAILED', code, desc, url);
  });
  // 渲染进程的报错必须能在主进程日志里看到。只报 CSP 的话，
  // React 渲染期抛异常会表现为「页面一片空白但 DOM 查询正常」这种极难定位的现象。
  mainWindow.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') {
      console.error(`[unroll] renderer ${e.level}:`, e.message);
    }
  });

  // §14.6 冒烟钩子。只有设了 UNROLL_SHOT 才动态加载，正常启动路径不碰它。
  if (process.env.UNROLL_SHOT) {
    const dir = process.env.UNROLL_SHOT;
    void import('./main/smoke').then((m) => m.runSmoke(mainWindow, dir, () => app.quit()));
  }

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', createWindow);

// 任何 webContents 都不许自己开窗口；外链交给系统浏览器（M6 的 README 链接会用到）
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// §7.3 的 IPC handler（M3）。
registerIpc();
