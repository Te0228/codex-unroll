/**
 * 选中态 + j/k 导航（F13 / F18 / §6.5）。
 *
 * 选中值是 Entry.index（全局序号），不是可见列表的下标——
 * 过滤条件变化时选中项不会莫名其妙跳到另一条上。
 */
import { useCallback, useMemo, useState } from 'react';
import type { Entry } from '../../shared/types';

export interface SelectionState {
  /** 当前选中的 Entry.index；未选中为 null（此时详情面板不渲染，F6） */
  selectedIndex: number | null;
  /** 选中且仍在可见列表里的条目；被过滤掉时为 null */
  selected: Entry | null;
  select: (index: number | null) => void;
  /** 再点同一条则关闭（F10） */
  toggle: (index: number) => void;
  clear: () => void;
  move: (delta: number) => void;
}

export function useSelection(visible: Entry[]): SelectionState {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  const selected = useMemo(
    () => (selectedIndex == null ? null : (visible.find((e) => e.index === selectedIndex) ?? null)),
    [visible, selectedIndex],
  );

  const select = useCallback((index: number | null) => setSelectedIndex(index), []);
  const clear = useCallback(() => setSelectedIndex(null), []);

  const toggle = useCallback(
    (index: number) => setSelectedIndex((cur) => (cur === index ? null : index)),
    [],
  );

  const move = useCallback(
    (delta: number) => {
      if (visible.length === 0) return;
      setSelectedIndex((cur) => {
        if (cur == null) return visible[delta >= 0 ? 0 : visible.length - 1].index;
        const pos = visible.findIndex((e) => e.index === cur);
        // 选中项被过滤掉了：从头（或尾）重新开始，而不是无响应
        if (pos === -1) return visible[delta >= 0 ? 0 : visible.length - 1].index;
        const next = Math.min(Math.max(pos + delta, 0), visible.length - 1);
        return visible[next].index;
      });
    },
    [visible],
  );

  // 身份稳定：App 里 openPath / 快捷键 effect 都依赖它，每次渲染换新对象会白白重挂监听
  return useMemo(
    () => ({ selectedIndex, selected, select, toggle, clear, move }),
    [selectedIndex, selected, select, toggle, clear, move],
  );
}
