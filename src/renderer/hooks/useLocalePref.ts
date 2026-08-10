/**
 * 语言偏好（SPEC §15）。
 *
 * 默认 **system**：跟随系统是唯一不需要用户表态就正确的默认值；
 * 写死 en 或 zh 都是在替一半用户做错的决定。
 *
 * 存 localStorage 而不是 useState：语言是长期表态，每次重开都要重选一次
 * 就等于没做（同 useViewMode / useCollapsedGroups 的理由）。
 * **不走 IPC**——preload 严格只暴露 8 个方法（§7.3 / 验收 E7），
 * 为了语言去动那个契约不值得；主进程那两条文案自己用 app.getLocale() 出。
 */
import { useEffect, useMemo, useState } from 'react';
import { asLocalePref, LOCALE_KEY, type LocalePref } from '../../shared/i18n';

const DEFAULT: LocalePref = 'system';

/** localStorage 在某些环境会抛，读写一律兜住 */
function read(): LocalePref {
  try {
    // 认不出的值（老版本写的、被人手改过的）由 asLocalePref 统一落到 'system'
    return asLocalePref(globalThis.localStorage?.getItem(LOCALE_KEY));
  } catch {
    return DEFAULT;
  }
}

export interface LocalePrefState {
  pref: LocalePref;
  setPref: (p: LocalePref) => void;
}

export function useLocalePref(): LocalePrefState {
  const [pref, setPref] = useState<LocalePref>(read);

  // 写在 effect 里而不是 setState 的 updater 里：StrictMode 下 updater 会跑两次
  useEffect(() => {
    try {
      globalThis.localStorage?.setItem(LOCALE_KEY, pref);
    } catch {
      /* 存不下就算了，语言偏好不值得打断用户 */
    }
  }, [pref]);

  // 身份稳定：这个对象会一路传到 Provider 和状态条，每次渲染换新对象会白白重渲染
  return useMemo(() => ({ pref, setPref }), [pref]);
}
