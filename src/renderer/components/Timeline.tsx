/**
 * 主区时间线（§6.1）。
 *
 * 不做虚拟滚动（§10.1 已定：实测行数 <20，做了是过度设计）。
 * 滚动的两条规则（F19 / G4 / G5）在 useAutoScroll 里，与「图」视图共用——
 * 各写一份迟早会分叉。
 */
import type { Entry } from '../../shared/types';
import { TimelineRow } from './TimelineRow';
import { useAutoScroll } from '../hooks/useAutoScroll';
import { useT } from '../i18n';

export interface TimelineProps {
  entries: Entry[];
  selectedIndex: number | null;
  onSelect: (index: number) => void;
  /** 有过滤/搜索但结果为空时的提示 */
  emptyHint?: string;
}

export function Timeline({ entries, selectedIndex, onSelect, emptyHint }: TimelineProps) {
  const { t } = useT();
  const { scrollRef, onScroll } = useAutoScroll(entries.length, selectedIndex);

  return (
    <div className="timeline" data-testid="timeline" ref={scrollRef} onScroll={onScroll}>
      <div className="timeline-inner" role="listbox" aria-label={t('ui.timeline')}>
        {entries.map((entry) => (
          <TimelineRow
            key={entry.index}
            entry={entry}
            selected={entry.index === selectedIndex}
            onSelect={onSelect}
          />
        ))}
        {entries.length === 0 && (
          <p className="sessions-empty">{emptyHint ?? t('ui.noMatchingEntries')}</p>
        )}
      </div>
    </div>
  );
}
