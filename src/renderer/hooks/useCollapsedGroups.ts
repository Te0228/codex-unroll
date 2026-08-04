/**
 * 组头折叠状态（SPEC §12 Q3）。
 *
 * 存 localStorage 而不是 useState：折叠是「我不关心这个项目」的长期表态，
 * 每次重开都要重新折一遍就等于没做。键用 project.key（`git:host/owner/repo`），
 * 路径变了、仓库没变时状态仍然跟得住。
 *
 * ⚠️ 不注册任何键盘快捷键——⌘1 已经是「折叠左栏」，别在同一个手势上叠两层语义。
 */
import { useCallback, useEffect, useState } from 'react';

export const COLLAPSED_KEY = 'unroll:collapsedProjects';

/** localStorage 在某些环境（隐私模式、未来的 partition 配置）会抛，读写一律兜住 */
function read(): Set<string> {
  try {
    const raw = globalThis.localStorage?.getItem(COLLAPSED_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === 'string'));
  } catch {
    return new Set();
  }
}

export interface CollapsedGroups {
  collapsed: Set<string>;
  isCollapsed(key: string): boolean;
  toggle(key: string): void;
  /** 自动展开（打开会话时用）。落进同一份持久化状态，
   *  否则会出现「这次自己展开了、下次又变回折叠」的诡异行为 */
  expand(key: string): void;
}

export function useCollapsedGroups(): CollapsedGroups {
  const [collapsed, setCollapsed] = useState<Set<string>>(read);

  // 写在 effect 里而不是 setState 的 updater 里：StrictMode 下 updater 会跑两次
  useEffect(() => {
    try {
      globalThis.localStorage?.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
    } catch {
      /* 存不下就算了，折叠状态不值得打断用户 */
    }
  }, [collapsed]);

  const toggle = useCallback((key: string) => {
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const expand = useCallback((key: string) => {
    setCollapsed((cur) => {
      if (!cur.has(key)) return cur; // 引用不变 → 不触发写盘、不多一次渲染
      const next = new Set(cur);
      next.delete(key);
      return next;
    });
  }, []);

  const isCollapsed = useCallback((key: string) => collapsed.has(key), [collapsed]);

  return { collapsed, isCollapsed, toggle, expand };
}
