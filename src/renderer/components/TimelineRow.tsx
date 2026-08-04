/**
 * 时间线的一行（§6.2）。
 *
 * ★ 固定单行、永不换行（F2 / F3）：
 *   高度钉死在 --row-h，white-space: nowrap + 省略号截断。
 *   11 459 字符的条目也只占一行——这是 §6.0「少量巨型对象」的直接后果，
 *   内容全部交给详情面板，时间线只承载结构。
 *
 * ★ React.memo：跟随追加新行时已有行不重渲染（G1）。
 */
import { memo } from 'react';
import type { Entry } from '../../shared/types';
import { GROUP_BY_ID, kindToGroup } from '../../shared/groups';
import { formatClock, kindLabel, rowPreview } from '../format';

export interface TimelineRowProps {
  entry: Entry;
  selected: boolean;
  onSelect: (index: number) => void;
}

function TimelineRowImpl({ entry, selected, onSelect }: TimelineRowProps) {
  const group = GROUP_BY_ID[kindToGroup(entry.kind)];
  return (
    <button
      type="button"
      className={`row${selected ? ' selected' : ''}`}
      data-testid="row"
      data-index={entry.index}
      data-group={group.id}
      data-kind={entry.kind}
      aria-selected={selected}
      onClick={() => onSelect(entry.index)}
    >
      <span className="row-index">{entry.index}</span>
      <span className="row-time">{formatClock(entry.timestamp)}</span>
      {/* 符号独立于颜色，灰度下也能区分（F21） */}
      <span className={`row-symbol g-${group.id}`} aria-label={group.label}>
        {group.symbol}
      </span>
      <span className={`row-kind g-${group.id}`}>{kindLabel(entry.kind)}</span>
      <span className="row-title">{entry.title}</span>
      <span className="row-preview">{rowPreview(entry.preview)}</span>
    </button>
  );
}

export const TimelineRow = memo(TimelineRowImpl);
