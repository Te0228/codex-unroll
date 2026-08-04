/**
 * 实时跟随的渲染侧（M5 / §7.4 / 验收 G1–G7）。
 *
 * 主进程负责 fs.watch + 120ms 去抖 + 只提交完整行（G2/G3），
 * 这里只做三件事：
 *   1. 订阅 onAppend / onReset（订阅只建一次，回调走 ref，避免频繁重订阅）
 *   2. enabled/path 变化时 watchSession / unwatchSession（G7：切会话不泄漏 watcher）
 *   3. 提供 isNearBottom —— 仅当用户已在底部时才自动滚动（G4/G5）
 */
import { useEffect, useRef } from 'react';
import type { AppendPayload, ResetPayload } from '../../shared/types';

/** §7.4 第 5 条：距底 <60px 视为「用户在底部」 */
export const NEAR_BOTTOM_PX = 60;

/**
 * 用户是否已滚到底部。滚动位置的判断放在纯函数里，
 * 这样 G4/G5 不必依赖真实布局就能测。
 */
export function isNearBottom(
  el: { scrollHeight: number; scrollTop: number; clientHeight: number },
  threshold = NEAR_BOTTOM_PX,
): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

export interface FollowOptions {
  enabled: boolean;
  /** 磁盘路径；拖放进来的文件没有路径时传 null，不跟随 */
  path: string | null;
  /** 跟随起点：readSession 返回的字节数（§7.4 第 1 条） */
  offset: number;
  onAppend: (lines: string[]) => void;
  onReset: () => void;
}

export function useFollow({ enabled, path, offset, onAppend, onReset }: FollowOptions): void {
  const appendRef = useRef(onAppend);
  const resetRef = useRef(onReset);
  const pathRef = useRef(path);
  const offsetRef = useRef(offset);
  appendRef.current = onAppend;
  resetRef.current = onReset;
  pathRef.current = path;
  offsetRef.current = offset;

  // 订阅只建一次：回调换了走 ref，不重订阅（否则主进程要反复收发退订消息）
  useEffect(() => {
    const api = window.unroll;
    if (!api?.onAppend || !api?.onReset) return;
    const offAppend = api.onAppend((p: AppendPayload) => {
      if (pathRef.current && p.path !== pathRef.current) return;
      if (p.lines?.length) appendRef.current(p.lines);
    });
    const offReset = api.onReset((p: ResetPayload) => {
      if (pathRef.current && p.path !== pathRef.current) return;
      resetRef.current();
    });
    return () => {
      offAppend?.();
      offReset?.();
    };
  }, []);

  // G7：enabled/path 变化即关掉旧 watcher，再开新的
  useEffect(() => {
    const api = window.unroll;
    if (!api?.watchSession || !enabled || !path) return;
    void api.watchSession(path, offsetRef.current);
    return () => {
      void api.unwatchSession?.();
    };
  }, [enabled, path]);
}
