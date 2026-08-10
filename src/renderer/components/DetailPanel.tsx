/**
 * 右栏详情面板（§6.1 / F6–F13）。
 *
 * 三条不要改回常规做法的约束：
 *   · 选中才渲染（App 里 entry 为 null 就整个不挂载，时间线占满宽度）——F6
 *   · 下钻**恰好两层**：这里是第二层，面板内除「原始 JSON」折叠外没有第三层展开——F13
 *     （§10.2 要求的「展开全部」只是同一段正文的截断阈值开关，不是新的一层，
 *       且只在正文 >2000 字符时才出现）
 *   · 独立滚动：.detail-body 自己 overflow:auto，body 永不滚——F12
 *
 * 会话头条目（kind === 'session'）额外展示 provider / effort / 耗时 / token，
 * 即被顶部状态条砍掉的那些摘要（F8）。
 */
import { useMemo, useState, type ReactNode, type RefObject } from 'react';
import type { Entry, SessionSummary } from '../../shared/types';
import { GROUP_BY_ID, kindToGroup } from '../../shared/groups';
import { DETAIL_TRUNCATE, formatClock, formatDuration, kindLabel } from '../format';
import { useT } from '../i18n';
import { RawJson } from './RawJson';

export interface DetailPanelProps {
  entry: Entry;
  summary: SessionSummary | null;
  onClose: () => void;
  onResizeStart: (e: { clientX: number; preventDefault?: () => void }) => void;
  /** ⌘F 聚焦面板内搜索（§6.5） */
  searchRef?: RefObject<HTMLInputElement | null>;
}

export function DetailPanel({ entry, summary, onClose, onResizeStart, searchRef }: DetailPanelProps) {
  // kindLabel 走 shared 目录取词，要显式的 locale——它不是组件，拿不到 Context
  const { locale, t, rt } = useT();
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState('');
  const group = GROUP_BY_ID[kindToGroup(entry.kind)];

  // preview 现在是 Text（可能是 MsgRef），截断与计数都按**译文**的长度算——
  // 用户看到的是译文，字符数说的也必须是译文的字符数，否则「已截断至 2000」对不上。
  const full = rt(entry.preview ?? '');
  const truncated = !expanded && full.length > DETAIL_TRUNCATE;
  const shown = truncated ? full.slice(0, DETAIL_TRUNCATE) : full;

  const hits = useMemo(() => countHits(shown, query), [shown, query]);

  return (
    <aside className="detail" data-testid="detail-panel" aria-label={t('ui.detail')}>
      {/* 拖拽把手：宽度写到 --panel-w（CSSOM），不用行内 style */}
      <div
        className="panel-resizer"
        data-testid="panel-resizer"
        role="separator"
        aria-orientation="vertical"
        onPointerDown={onResizeStart}
        onMouseDown={onResizeStart}
      />

      <div className="detail-head">
        <span className={`g-${group.id}`} aria-label={t(group.labelKey)}>
          {group.symbol}
        </span>
        <h2 className="detail-title" data-testid="detail-title">
          {rt(entry.title) || kindLabel(locale, entry.kind)}
        </h2>
        <span className="detail-type">{entry.payloadType || entry.topType}</span>
        <button className="icon-btn detail-close" onClick={onClose} aria-label={t('ui.closeDetail')}>
          ✕
        </button>
      </div>

      <div className="detail-search">
        <span aria-hidden="true">🔍</span>
        <input
          ref={searchRef}
          data-testid="detail-search"
          aria-label={t('ui.searchInEntry')}
          placeholder={t('ui.searchInEntryPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && <span className="hits">{t('ui.hits', { n: hits })}</span>}
      </div>

      <div className="detail-body" data-testid="detail-body">
        <dl className="detail-meta">
          <dt>{t('ui.type')}</dt>
          <dd>
            {entry.topType}
            {entry.payloadType ? ` / ${entry.payloadType}` : ''}
          </dd>
          <dt>{t('ui.time')}</dt>
          <dd>{formatClock(entry.timestamp)}</dd>
          {entry.callId && (
            <>
              <dt>call_id</dt>
              <dd className="mono">{entry.callId}</dd>
            </>
          )}
          {entry.turnId && (
            <>
              <dt>turn_id</dt>
              <dd className="mono">{entry.turnId}</dd>
            </>
          )}
          {entry.kind === 'session' && summary && <SummaryRows summary={summary} />}
        </dl>

        {shown ? (
          <pre className="detail-content mono" data-testid="detail-content">
            {highlight(shown, query)}
          </pre>
        ) : (
          <p className="detail-empty">{t('ui.noBody')}</p>
        )}

        {full.length > DETAIL_TRUNCATE && (
          <p className="truncate-note">
            <span>
              {t('ui.bodyChars', { n: full.length })}
              {truncated ? t('ui.truncatedTo', { n: DETAIL_TRUNCATE }) : ''}
            </span>
            <button className="link-btn" data-testid="expand-all" onClick={() => setExpanded((v) => !v)}>
              {truncated ? t('ui.expandAll') : t('ui.collapse')}
            </button>
          </p>
        )}

        <RawJson pretty={entry.rawPretty} value={entry.raw} query={query} />
      </div>
    </aside>
  );
}

/** 会话头条目才展示的会话级摘要（F8：被顶部状态条砍掉的那几个值在这里） */
function SummaryRows({ summary }: { summary: SessionSummary }) {
  const { t } = useT();
  const tokens =
    summary.inputTokens != null || summary.outputTokens != null
      ? `${summary.inputTokens ?? 0} in / ${summary.outputTokens ?? 0} out`
      : '—';
  return (
    <>
      <dt>provider</dt>
      <dd>{summary.provider || '—'}</dd>
      <dt>model</dt>
      <dd>{summary.model || '—'}</dd>
      <dt>effort</dt>
      <dd>{summary.effort || '—'}</dd>
      <dt>approval</dt>
      <dd>{summary.approval || '—'}</dd>
      <dt>sandbox</dt>
      <dd>{summary.sandbox || '—'}</dd>
      <dt>cwd</dt>
      <dd className="mono">{summary.cwd || '—'}</dd>
      <dt>cli</dt>
      <dd>{summary.cliVersion || '—'}</dd>
      <dt>{t('ui.duration')}</dt>
      <dd>
        {formatDuration(summary.durationMs)}
        {summary.ttftMs != null ? t('ui.ttftParen', { value: formatDuration(summary.ttftMs) }) : ''}
      </dd>
      <dt>token</dt>
      <dd>{tokens}</dd>
    </>
  );
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function countHits(text: string, query: string): number {
  const q = query.trim();
  if (!q) return 0;
  return text.toLowerCase().split(q.toLowerCase()).length - 1;
}

/** ⌘F 的面板内搜索：命中处包 <mark>，不改变文本本身（复制出去还是原文） */
export function highlight(text: string, query: string): ReactNode {
  const q = query.trim();
  if (!q) return text;
  const parts = text.split(new RegExp(`(${escapeRe(q)})`, 'gi'));
  return parts.map((part, i) =>
    part.toLowerCase() === q.toLowerCase() ? <mark key={i}>{part}</mark> : part,
  );
}
