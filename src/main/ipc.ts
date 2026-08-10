/**
 * IPC 注册（SPEC §7.3）。
 *
 * 这里**只做薄薄一层**：参数校验 + 把 sessions.ts / watcher.ts 的结果转给渲染进程。
 * 真正的逻辑都在那两个文件里，因为它们不依赖 electron，可以直接单测（§14.7）。
 *
 * 渲染进程是不可信输入源（哪怕它是我们自己写的）：所有入参先校验类型再用。
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import type { WebContents } from 'electron';

import { IPC } from '../shared/types';
import { localeFromLanguage, translate } from '../shared/i18n';
import { readSessionFile, resolveCodexHome, scanSessions } from './sessions';
import { startWatching, stopWatching } from './watcher';

function requirePath(v: unknown): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error('invalid file path');
  }
  return v;
}

/** 只在目标窗口还活着时推送，避免窗口关了以后回调炸掉 */
function send(wc: WebContents, channel: string, payload: unknown): void {
  if (wc.isDestroyed()) return;
  wc.send(channel, payload);
}

let registered = false;

/** 在 src/main.ts 里调用一次。重复调用是空操作（HMR 下不会重复注册）。 */
export function registerIpc(): void {
  if (registered) return;
  registered = true;

  // ── 扫描（E1–E3） ──────────────────────────────────────────
  ipcMain.handle(IPC.listSessions, () => scanSessions(resolveCodexHome()));

  // ── 读取（E4 / E5） ────────────────────────────────────────
  ipcMain.handle(IPC.readSession, (_e, file: unknown) => readSessionFile(requirePath(file)));

  // ── 跟随（§7.4、G1–G7） ───────────────────────────────────
  ipcMain.handle(IPC.watchSession, (e, file: unknown, fromOffset: unknown) => {
    const target = requirePath(file);
    const offset = typeof fromOffset === 'number' && Number.isFinite(fromOffset) ? fromOffset : 0;
    const wc = e.sender;
    // startWatching 内部会先关掉上一个 watcher —— 同一时刻只跟一个文件（G7）
    return startWatching({
      path: target,
      fromOffset: offset,
      onAppend: (lines) => send(wc, IPC.onAppend, { path: target, lines }),
      onReset: () => send(wc, IPC.onReset, { path: target }),
      onError: (err) => console.error('[unroll] watch error', target, err),
    });
  });

  ipcMain.handle(IPC.unwatchSession, () => {
    stopWatching();
  });

  // ── 文件选择 / 在访达中显示 ────────────────────────────────
  ipcMain.handle(IPC.openFileDialog, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    /**
     * ★ 主进程走的是**系统语言**，不是渲染层那个偏好（§15）。
     *   偏好存在渲染进程的 localStorage 里，主进程读不到，而 preload 严格
     *   只有 8 个方法（§7.3 / 验收 E7）——为了两条对话框文案去加一个 IPC 通道
     *   不值得。代价是：用户手动切到英文时，这个系统对话框仍是系统语言。
     *   反正对话框的按钮（打开/取消）本来就是操作系统画的、跟着系统语言走，
     *   标题跟着系统反而比跟着 app 内偏好更一致。
     * ★ 在 handler 里现取而不是模块加载时取：app.getLocale() 要求 app ready。
     */
    const locale = localeFromLanguage(app.getLocale());
    const opts: Electron.OpenDialogOptions = {
      title: translate(locale, 'ui.openRollout'),
      properties: ['openFile'],
      filters: [
        // Rollout JSONL 是格式名，不翻译
        { name: 'Rollout JSONL', extensions: ['jsonl'] },
        { name: translate(locale, 'ui.allFiles'), extensions: ['*'] },
      ],
    };
    const res = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0];
  });

  ipcMain.handle(IPC.revealInFinder, (_e, file: unknown) => {
    shell.showItemInFolder(requirePath(file));
  });

  // 窗口全关时别留着 watcher（G7 的兜底）
  app.on('window-all-closed', () => stopWatching());
}
