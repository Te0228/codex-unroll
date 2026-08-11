/**
 * 右栏详情面板（§6.1 / F6–F13，v0.2 加了 F14 / F18 / F20）。
 *
 * 三条不要改回常规做法的约束：
 *   · 选中才渲染（App 里 entry 为 null 就整个不挂载，时间线占满宽度）——F6
 *   · 下钻**恰好两层**：这里是第二层，面板内除「原始 JSON」折叠外没有第三层——F13
 *     （§10.2 要求的「展开全部」只是同一段正文的截断阈值开关，不是新的一层，
 *       且只在正文 >2000 字符时才出现；F20 的分段折叠同理，见 BodySections 文件头）
 *   · 独立滚动：.detail-body 自己 overflow:auto，body 永不滚——F12
 *
 * 会话头条目（kind === 'session'）额外展示 provider / effort / 耗时 / token，
 * 即被顶部状态条砍掉的那些摘要（F8）。
 *
 * ── v0.2 的三件事都挂在正文上方那条工具栏里 ──────────────────────
 *   F14 互跳：工具调用 ⇄ 工具结果，靠 `call_id`（shared/pairing.ts）
 *   F18 复制：正文 / 原始 JSON，复制的都是**已脱敏**的那份（§9.1）
 *   F20 分段：正文按 markdown 标题切成可折叠的段
 */
import { useMemo, useState, type RefObject } from 'react';
import type { Entry, SessionSummary } from '../../shared/types';
import { GROUP_BY_ID, kindToGroup } from '../../shared/groups';
import { counterpart, type CallPair } from '../../shared/pairing';
import { DETAIL_TRUNCATE, formatClock, formatDuration, kindLabel } from '../format';
import { useT } from '../i18n';
import { RawJson } from './RawJson';
import { CopyButtons } from './CopyButtons';
import { BodySections, splitSections } from './BodySections';
import { countHits, highlight } from './Highlight';

// 这两个曾经定义在本文件里；分段视图也要用，已挪进 Highlight.tsx。
// 保留再导出，是为了不改动可能存在的外部引用点。
export { countHits, highlight };

export interface DetailPanelProps {
  entry: Entry;
  summary: SessionSummary | null;
  onClose: () => void;
  onResizeStart: (e: { clientX: number; preventDefault?: () => void }) => void;
  /** ⌘F 聚焦面板内搜索（§6.5） */
  searchRef?: RefObject<HTMLInputElement | null>;
  /**
   * F14 工具调用配对表。**必须用全量 entries 建**（`buildPairs(entries)`），
   * 不能用过滤后的 visible——用户把「行动」组关掉时对家就找不到了，
   * 而互跳的意义恰恰是「跳到当前没在看的那一条」。
   *
   * 不传（或传空）就完全不渲染互跳区，不会出现点了没反应的按钮。
   */
  pairs?: Map<string, CallPair>;
  /** F14 互跳：跳到对家条目。参数是 `Entry.index`，由 App 转成选中 */
  onJump?: (index: number) => void;
}

export function DetailPanel({
  entry,
  summary,
  onClose,
  onResizeStart,
  searchRef,
  pairs,
  onJump,
}: DetailPanelProps) {
  // kindLabel 走 shared 目录取词，要显式的 locale——它不是组件，拿不到 Context
  const { locale, t, rt } = useT();
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState('');
  const group = GROUP_BY_ID[kindToGroup(entry.kind)];

  // preview 现在是 Text（可能是 MsgRef），截断与计数都按**译文**的长度算——
  // 用户看到的是译文，字符数说的也必须是译文的字符数，否则「已截断至 2000」对不上。
  const full = rt(entry.preview ?? '');

  // F20：切段是纯字符串运算，正文没变就别重算（AGENTS.md 那条 23 041 字符）
  const sections = useMemo(
    () => (full.length > DETAIL_TRUNCATE ? splitSections(full) : []),
    [full],
  );
  /** 只有「确实大」且「真的切出 ≥2 段」才提供分段视图，理由见 BodySections 文件头 */
  const sectionable = sections.length >= 2;
  const [sectioned, setSectioned] = useState(true);
  const showSections = sectionable && sectioned;

  const truncated = !showSections && !expanded && full.length > DETAIL_TRUNCATE;
  const shown = truncated ? full.slice(0, DETAIL_TRUNCATE) : full;

  // 分段视图下正文分散在各段里，命中数按**全文**算才不会骗人
  const hits = useMemo(
    () => countHits(showSections ? full : shown, query),
    [showSections, full, shown, query],
  );

  const mate = pairs ? counterpart(pairs, entry) : undefined;
  const isTool = entry.kind === 'tool_call' || entry.kind === 'tool_out';

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

        {/*
         * F14 · 工具调用互跳。
         * 配得上对家 → 一个按钮；配不上 → 一句说明（**不是**一个点了没反应的按钮）。
         * 两者都只在工具条目上出现，别的记录本来就没有对家这回事。
         */}
        {isTool && pairs && (
          <div className="detail-pair" data-testid="detail-pair">
            {mate && onJump ? (
              <button
                type="button"
                className="link-btn"
                data-testid="jump-counterpart"
                data-target={mate.index}
                onClick={() => onJump(mate.index)}
              >
                {t(entry.kind === 'tool_call' ? 'ui.jumpToOutput' : 'ui.jumpToCall')}
              </button>
            ) : (
              <span className="detail-pair-none" data-testid="no-counterpart">
                {t('ui.noCounterpart')}
              </span>
            )}
          </div>
        )}

        <CopyButtons body={full} json={entry.rawPretty} />

        {/*
         * F20 · 分段 ⇄ 整段。用 aria-pressed 而不是 aria-expanded：
         * 这是视图切换，不是又一层下钻（同 RawJson 的视图按钮）。
         */}
        {sectionable && (
          <div className="detail-viewswitch" role="group" aria-label={t('ui.sections')}>
            <button
              type="button"
              className={`rawjson-view${showSections ? ' on' : ''}`}
              aria-pressed={showSections}
              data-testid="view-sections"
              onClick={() => setSectioned(true)}
            >
              {t('ui.sections')}
            </button>
            <button
              type="button"
              className={`rawjson-view${showSections ? '' : ' on'}`}
              aria-pressed={!showSections}
              data-testid="view-whole"
              onClick={() => setSectioned(false)}
            >
              {t('ui.wholeText')}
            </button>
            <span className="detail-section-count" data-testid="section-count">
              {t('ui.sectionCount', { n: sections.length })}
            </span>
          </div>
        )}

        {showSections ? (
          <BodySections sections={sections} query={query} />
        ) : shown ? (
          <pre className="detail-content mono" data-testid="detail-content">
            {highlight(shown, query)}
          </pre>
        ) : (
          <p className="detail-empty">{t('ui.noBody')}</p>
        )}

        {!showSections && full.length > DETAIL_TRUNCATE && (
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
