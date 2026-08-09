/**
 * 主区视图：图 / 列表（SPEC §6.8）。
 *
 * 默认 **graph**：图承载的是 Codex 真实的执行层级（Turn ▸ Step），
 * 一眼能看出「模型问了几次、每次是调工具还是收工」；列表是平的，看不出这个。
 *
 * 存 localStorage 而不是 useState：视图偏好是长期表态，
 * 每次重开都要重切一次就等于没做（同 useCollapsedGroups 的理由）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

export const VIEW_KEY = 'unroll:view';

export type ViewMode = 'graph' | 'list';

const DEFAULT: ViewMode = 'graph';

/** localStorage 在某些环境会抛，读写一律兜住 */
function read(): ViewMode {
  try {
    return globalThis.localStorage?.getItem(VIEW_KEY) === 'list' ? 'list' : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

export interface ViewModeState {
  view: ViewMode;
  setView: (v: ViewMode) => void;
  toggle: () => void;
}

export function useViewMode(): ViewModeState {
  const [view, setView] = useState<ViewMode>(read);

  // 写在 effect 里而不是 setState 的 updater 里：StrictMode 下 updater 会跑两次
  useEffect(() => {
    try {
      globalThis.localStorage?.setItem(VIEW_KEY, view);
    } catch {
      /* 存不下就算了，视图偏好不值得打断用户 */
    }
  }, [view]);

  const toggle = useCallback(() => setView((v) => (v === 'graph' ? 'list' : 'graph')), []);

  // 身份稳定：App 的快捷键 effect 依赖它，每次渲染换新对象会白白重挂监听
  return useMemo(() => ({ view, setView, toggle }), [view, toggle]);
}
