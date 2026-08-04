/**
 * 主区时间线（§6.1）。
 *
 * 不做虚拟滚动（§10.1 已定：实测行数 <20，做了是过度设计）。
 * 两件与滚动有关的事：
 *   · 选中项在视口外时滚入视口（F19）
 *   · 跟随追加时，仅当用户已在底部才自动滚到底（G4/G5）
 */
import { useEffect, useLayoutEffect, useRef } from 'react';
import type { Entry } from '../../shared/types';
import { TimelineRow } from './TimelineRow';
import { isNearBottom } from '../hooks/useFollow';

export interface TimelineProps {
  entries: Entry[];
  selectedIndex: number | null;
  onSelect: (index: number) => void;
  /** 有过滤/搜索但结果为空时的提示 */
  emptyHint?: string;
}

export function Timeline({ entries, selectedIndex, onSelect, emptyHint }: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 渲染**前**记录的「用户是否在底部」——渲染后 scrollHeight 已经变了，来不及判断（§7.4 第 5 条） */
  const atBottomRef = useRef(true);
  const countRef = useRef(entries.length);

  // useLayoutEffect 在 DOM 更新后、浏览器绘制前跑：此时读到的是新高度，
  // 而 atBottomRef 还是上一次 scroll 事件记下的旧状态，正是我们要的。
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const grew = entries.length > countRef.current;
    countRef.current = entries.length;
    if (grew && atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [entries.length]);

  useEffect(() => {
    if (selectedIndex == null) return;
    const el = scrollRef.current?.querySelector(`[data-index="${selectedIndex}"]`);
    if (el && typeof (el as HTMLElement).scrollIntoView === 'function') {
      (el as HTMLElement).scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  return (
    <div
      className="timeline"
      data-testid="timeline"
      ref={scrollRef}
      onScroll={(e) => {
        atBottomRef.current = isNearBottom(e.currentTarget);
      }}
    >
      <div className="timeline-inner" role="listbox" aria-label="时间线">
        {entries.map((entry) => (
          <TimelineRow
            key={entry.index}
            entry={entry}
            selected={entry.index === selectedIndex}
            onSelect={onSelect}
          />
        ))}
        {entries.length === 0 && <p className="sessions-empty">{emptyHint ?? '没有匹配的条目'}</p>}
      </div>
    </div>
  );
}
