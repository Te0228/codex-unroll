/**
 * 主区滚动的两条规则，时间线与图共用（§7.4 第 5 条 / F19 / G4 / G5）：
 *
 *   · 跟随追加时，**仅当用户已在底部**才自动滚到底
 *   · 选中项在视口外时滚进视口
 *
 * 抽出来是因为两个视图必须表现一致——各写一份迟早会分叉。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject, type UIEvent } from 'react';
import { isNearBottom } from './useFollow';

export interface AutoScroll {
  scrollRef: RefObject<HTMLDivElement | null>;
  onScroll: (e: UIEvent<HTMLElement>) => void;
}

/**
 * @param count 条目总数，只用来判断「是不是变多了」
 * @param selectedIndex 当前选中的 Entry.index，容器内靠 `[data-index]` 定位
 */
export function useAutoScroll(count: number, selectedIndex: number | null): AutoScroll {
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 渲染**前**记录的「用户是否在底部」——渲染后 scrollHeight 已经变了，来不及判断 */
  const atBottomRef = useRef(true);
  const countRef = useRef(count);

  // useLayoutEffect 在 DOM 更新后、浏览器绘制前跑：此时读到的是新高度，
  // 而 atBottomRef 还是上一次 scroll 事件记下的旧状态，正是我们要的。
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const grew = count > countRef.current;
    countRef.current = count;
    if (grew && atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [count]);

  useEffect(() => {
    if (selectedIndex == null) return;
    const el = scrollRef.current?.querySelector(`[data-index="${selectedIndex}"]`);
    if (el && typeof (el as HTMLElement).scrollIntoView === 'function') {
      (el as HTMLElement).scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  const onScroll = useCallback((e: UIEvent<HTMLElement>) => {
    atBottomRef.current = isNearBottom(e.currentTarget);
  }, []);

  return { scrollRef, onScroll };
}
