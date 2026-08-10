/**
 * 时间线的一行（§6.2）。
 *
 * ★ 固定单行、永不换行（F2 / F3）：
 *   高度钉死在 --row-h，white-space: nowrap + 省略号截断。
 *   11 459 字符的条目也只占一行——这是 §6.0「少量巨型对象」的直接后果，
 *   内容全部交给详情面板，时间线只承载结构。
 *
 * ★ React.memo：跟随追加新行时已有行不重渲染（G1）。
 *   订阅了语言 context 之后 memo 依然成立——context 变化会绕过 memo 强制重渲染，
 *   而这正是切语言时需要的：所有行同时换语言，追加新行时仍然一行都不动。
 */
import { memo } from 'react';
import type { Entry } from '../../shared/types';
import { GROUP_BY_ID, kindToGroup } from '../../shared/groups';
import { formatClock, kindLabel, rowPreview } from '../format';
import { useT } from '../i18n';

export interface TimelineRowProps {
  entry: Entry;
  selected: boolean;
  onSelect: (index: number) => void;
}

function TimelineRowImpl({ entry, selected, onSelect }: TimelineRowProps) {
  // kindLabel 走 shared 目录取词，要显式的 locale——它不是组件，拿不到 Context
  const { locale, t, rt } = useT();
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
      <span className={`row-symbol g-${group.id}`} aria-label={t(group.labelKey)}>
        {group.symbol}
      </span>
      <span className={`row-kind g-${group.id}`}>{kindLabel(locale, entry.kind)}</span>
      {/* title / preview 是 Text（可能是 MsgRef），塞进 DOM 前必须先 rt 成字符串 */}
      <span className="row-title">{rt(entry.title)}</span>
      <span className="row-preview">{rowPreview(rt(entry.preview))}</span>
    </button>
  );
}

export const TimelineRow = memo(TimelineRowImpl);
