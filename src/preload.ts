// 渲染进程与主进程之间唯一的通道。
//
// 运行在 sandbox: true 下——这里只能用 contextBridge / ipcRenderer，
// 不能 import node:fs 之类的内置模块（Forge 会把本文件打成 CJS，兼容 sandbox）。
//
// 严格按 SPEC §7.3 暴露 8 个方法，不多不少（验收 §14.3 E7：
// `Object.keys(window.unroll).length === 8`）。
//
// 注：`../shared/types` 只被拿来取 IPC 常量与类型，全部会被打包进 preload，
// 不引入任何运行时依赖，sandbox 下安全。
import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

import { IPC } from './shared/types';
import type { AppendPayload, ResetPayload, UnrollAPI } from './shared/types';

/**
 * 订阅一个主 → 渲染的推送，返回取消订阅函数。
 * 用 `ipcRenderer.on` + 对应的 `removeListener`，组件卸载时不留监听器。
 */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api: UnrollAPI = {
  listSessions: () => ipcRenderer.invoke(IPC.listSessions),
  readSession: (file) => ipcRenderer.invoke(IPC.readSession, file),
  watchSession: (file, fromOffset) => ipcRenderer.invoke(IPC.watchSession, file, fromOffset),
  unwatchSession: () => ipcRenderer.invoke(IPC.unwatchSession),
  onAppend: (cb) => subscribe<AppendPayload>(IPC.onAppend, cb),
  onReset: (cb) => subscribe<ResetPayload>(IPC.onReset, cb),
  openFileDialog: () => ipcRenderer.invoke(IPC.openFileDialog),
  revealInFinder: (file) => ipcRenderer.invoke(IPC.revealInFinder, file),
};

contextBridge.exposeInMainWorld('unroll', api);
