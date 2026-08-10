/**
 * 主区的「图」视图（SPEC §6.8）：Session ▸ Turn ▸ Step 的竖向链。
 *
 * 形态定下来的理由，实现时别改回去：
 *
 * 1. **竖向链，不是环。** turn loop 是 ReAct 循环没错，但真实会话动辄几十个
 *    Step，画成环会糊成一团。竖着串 Step 1 ↓ Step 2 ↓ …，Step 再多也只是变长。
 * 2. **块只承载结构。** 和时间线一样遵守 §6.0：块里每条仍是固定单行的 `.row`，
 *    内容全部交给右侧详情面板。下钻仍然恰好两层（图 → 详情面板）。
 * 3. **结构不随过滤器变形。** 图是从**全量** entries 切的，过滤只决定哪些行
 *    渲染出来。否则关掉「元信息」就会连 token_count 一起滤掉，
 *    而 Step 边界正是靠它切的——结构会当场散架。
 *
 * Turn 前言（task_started / world_state / turn_context / 系统消息）默认收起，
 * 只留用户消息和异常两类常显——这两类是「这一轮为什么开始」和「哪里出问题了」。
 */
import { Fragment, memo, useState } from 'react';
import type { Entry } from '../../shared/types';
import type { SessionGraph, StepNode, StepOutcome, TurnNode } from '../../shared/steps';
import { isUserInput } from '../../shared/steps';
import { TimelineRow } from './TimelineRow';
import { useAutoScroll } from '../hooks/useAutoScroll';
import { formatDuration } from '../format';

/** Step 的收场：符号独立于颜色，灰度下也要能区分（同 §6.3 / F21 的原则） */
const OUTCOME: Record<StepOutcome, { symbol: string; label: string }> = {
  act: { symbol: '▶', label: '调用工具' },
  answer: { symbol: '●', label: '收工' },
  open: { symbol: '·', label: '未收尾' },
};

export interface StepGraphProps {
  graph: SessionGraph;
  /** 过滤/搜索后仍可见的 Entry.index 集合 */
  visible: Set<number>;
  selectedIndex: number | null;
  onSelect: (index: number) => void;
  /** 条目总数，供跟随时判断「是不是变多了」 */
  total: number;
  /** 有过滤/搜索但一条都没命中时的提示，与时间线保持一致 */
  emptyHint?: string;
}

export function StepGraph({
  graph,
  visible,
  selectedIndex,
  onSelect,
  total,
  emptyHint,
}: StepGraphProps) {
  const { scrollRef, onScroll } = useAutoScroll(total, selectedIndex);
  const empty = graph.turns.length === 0 && graph.preamble.length === 0;

  return (
    <div className="graph" data-testid="graph" ref={scrollRef} onScroll={onScroll}>
      <div className="graph-inner">
        {/*
         * ★ 一条都没命中时必须给话说（F17b：不许白屏）。
         *   光靠下面「Turn/Step 骨架 + N 条被过滤」不够——会话若**一个 Turn 都没有**
         *   （全是无 Turn 标记的条目，见 §14.9 S15 的形状），骨架本身也是空的，
         *   主区会整片空白。所以这条提示挂在最外层，不依赖任何骨架。
         */}
        {!empty && visible.size === 0 && (
          <p className="sessions-empty" data-testid="graph-empty">
            {emptyHint ?? '没有匹配的条目'}
          </p>
        )}

        {graph.preamble.length > 0 && (
          <section className="graph-pre" data-testid="graph-preamble">
            <Rows entries={graph.preamble} visible={visible} sel={selectedIndex} onSelect={onSelect} />
          </section>
        )}

        {graph.turns.map((turn) => (
          <Turn
            key={turn.no}
            turn={turn}
            visible={visible}
            selectedIndex={selectedIndex}
            onSelect={onSelect}
          />
        ))}

        {empty && <p className="sessions-empty">没有可展示的条目</p>}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────

interface TurnProps {
  turn: TurnNode;
  visible: Set<number>;
  selectedIndex: number | null;
  onSelect: (index: number) => void;
}

function Turn({ turn, visible, selectedIndex, onSelect }: TurnProps) {
  const config = [turn.model, turn.effort, turn.approval, turn.sandbox].filter(Boolean).join(' · ');
  const end = turn.end;

  return (
    <section className="turn" data-testid="turn" data-turn={turn.no} data-status={turn.status}>
      <header className="turn-head">
        <span className="turn-no">Turn {turn.no}</span>
        {config && <span className="turn-config">{config}</span>}
        <span className="spacer" />
        <span className="turn-steps">{turn.steps.length} step</span>
      </header>

      <TurnPreamble
        entries={turn.preamble}
        visible={visible}
        selectedIndex={selectedIndex}
        onSelect={onSelect}
      />

      <div className="steps">
        {turn.steps.map((step, i) => (
          <Fragment key={step.no}>
            <Step step={step} visible={visible} selectedIndex={selectedIndex} onSelect={onSelect} />
            {i < turn.steps.length - 1 && (
              <p className="step-link" data-testid="step-link">
                <span className="step-arrow" aria-hidden="true">
                  ↓
                </span>
                {step.outcome === 'act' ? '工具结果写回历史，再问一次模型' : '继续'}
              </p>
            )}
          </Fragment>
        ))}
        {turn.steps.length === 0 && <p className="step-empty">这一轮没有模型产出</p>}
      </div>

      <footer className="turn-foot">
        {turn.status === 'complete' ? (
          <>
            <span>{formatDuration(turn.durationMs)}</span>
            {turn.ttftMs != null && <span>首字 {formatDuration(turn.ttftMs)}</span>}
            {end && (
              <button
                type="button"
                className="link-btn"
                onClick={() => onSelect(end.index)}
                data-testid="turn-end"
              >
                task_complete
              </button>
            )}
          </>
        ) : (
          <span className="turn-open">进行中 · 未见 task_complete</span>
        )}
      </footer>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────

/**
 * Turn 前言（task_started / 系统与开发者消息 / world_state / turn_context / 用户输入）。
 *
 * ★ **默认全展开。** 这里一度默认收起，结果 19 条的会话在图里只显出 10 条——
 *   藏掉了近一半。查看器的职责是「摊开」不是「摘要」，看不见的东西等于不存在。
 *   收起仍然留着（长会话里 AGENTS.md 那几条确实占地方），但要用户自己按。
 *
 * 折叠时保留常显的两类：**真人输入**（这一轮为什么开始）和**异常**（哪里出问题了）。
 *
 * ⚠️ 这个展开**不算一层下钻**（§14.8 的既定口径：本层内部导航不计），
 *    所以不打 `data-drill`。真正的下钻仍然只有「图 → 详情面板」这一次。
 */
function TurnPreamble({ entries, visible, selectedIndex, onSelect }: Omit<TurnProps, 'turn'> & { entries: Entry[] }) {
  const [open, setOpen] = useState(true);
  if (entries.length === 0) return null;

  /**
   * 同一句用户输入常常落两份（event_msg/user_message + response_item/message）。
   * 折叠态下两份都留就成了重复噪音，所以**有事件那份就只认事件那份**，
   * 没有才退回 response_item——退路存在的理由见 isUserInput 的注释。
   */
  const hasEventUser = entries.some((e) => e.payloadType === 'user_message');
  const isLead = (e: Entry) =>
    e.kind === 'error' || (hasEventUser ? e.payloadType === 'user_message' : isUserInput(e));
  const foldable = entries.filter((e) => !isLead(e)).length;
  const shown = open ? entries : entries.filter(isLead);

  return (
    <div className="turn-pre" data-testid="turn-preamble">
      <Rows entries={shown} visible={visible} sel={selectedIndex} onSelect={onSelect} />
      {foldable > 0 && (
        <button
          type="button"
          className="turn-pre-toggle"
          aria-expanded={open}
          data-testid="turn-preamble-toggle"
          onClick={() => setOpen((v) => !v)}
        >
          <span aria-hidden="true">{open ? '▾' : '▸'}</span>
          {open ? `收起上下文 ${foldable} 条` : `展开上下文 ${foldable} 条`}
        </button>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────

interface StepProps {
  step: StepNode;
  visible: Set<number>;
  selectedIndex: number | null;
  onSelect: (index: number) => void;
}

const Step = memo(function Step({ step, visible, selectedIndex, onSelect }: StepProps) {
  const o = OUTCOME[step.outcome];
  const shown = step.entries.filter((e) => visible.has(e.index));
  const filtered = step.entries.length - shown.length;
  const usage = step.usage;

  return (
    <article
      className="step"
      data-testid="step"
      data-step={step.no}
      data-outcome={step.outcome}
      data-error={step.hasError || undefined}
    >
      <header className="step-head">
        <span className="step-no">Step {step.no}</span>
        {step.tools.length > 0 && <span className="step-tools">{step.tools.join(' · ')}</span>}
        <span className="spacer" />
        <span className={`step-outcome o-${step.outcome}`}>
          <span aria-hidden="true">{o.symbol}</span> {o.label}
        </span>
      </header>

      <div className="step-body">
        {shown.map((e) => (
          <TimelineRow
            key={e.index}
            entry={e}
            selected={e.index === selectedIndex}
            onSelect={onSelect}
          />
        ))}
        {filtered > 0 && <p className="step-filtered">{filtered} 条被过滤</p>}
        {step.entries.length === 0 && <p className="step-filtered">这一步没有可见产出</p>}
      </div>

      {usage && (
        <button
          type="button"
          className={`step-foot${usage.index === selectedIndex ? ' selected' : ''}`}
          data-testid="step-usage"
          onClick={() => onSelect(usage.index)}
        >
          {step.inputTokens ?? '—'} → {step.outputTokens ?? '—'} tok
        </button>
      )}
    </article>
  );
});

// ─────────────────────────────────────────────────────────────

function Rows({
  entries,
  visible,
  sel,
  onSelect,
}: {
  entries: Entry[];
  visible: Set<number>;
  sel: number | null;
  onSelect: (index: number) => void;
}) {
  const shown = entries.filter((e) => visible.has(e.index));
  if (shown.length === 0) return null;
  return (
    <>
      {shown.map((e) => (
        <TimelineRow key={e.index} entry={e} selected={e.index === sel} onSelect={onSelect} />
      ))}
    </>
  );
}
