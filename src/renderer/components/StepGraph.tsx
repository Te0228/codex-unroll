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
 * 「图感」来自三样东西，缺一样就退化成带框的分组列表：
 *   · **主干线**——Turn 左侧一条贯穿的竖线，Step 挂在它上面。没有边就没有图。
 *   · **节点**——Step 序号做成干线上的圆点，而不是满宽标题栏里的一行字。
 *   · **支线**——工具调用与它的结果缩进成一段支出去又回来的括号。
 *     ReAct 里最有形状的一步就是「出去调工具、带着结果回来」，
 *     摆成上下相邻的两行是读不出来的。
 *
 * Turn 前言（task_started / world_state / turn_context / 系统消息）**默认全展开**，
 * 收起后仍保留用户消息和异常两类——「这一轮为什么开始」和「哪里出问题了」。
 *
 * ── v0.2 在图上叠的三件事（SPEC §5 P1）─────────────────────────────
 *   · **F15 整轮折叠**（本文件的 `Turn`）：头尾留着，正文收起，说清藏了几条。
 *   · **F16 工具耗时条**（`MetricTiming`）：刻度是**全会话共用**的一把尺子，
 *     在本文件算一次往下传——各 Step 自己归一化会把长短关系画反。
 *   · **F17 Token 用量图**（`MetricTokens`）：默认画单步增量，
 *     因为 `total_token_usage` 是累计值，直接画会得到一条骗人的斜线。
 * 三者都从**全量** entries 取数，过滤只决定哪些行渲染（§6.8.5 第 3 条）——
 * 度量跟着过滤器变，比不显示更糟：那是**错的数字**，不是缺的数字。
 */
import { Fragment, memo, useMemo, useState } from 'react';
import type { Entry } from '../../shared/types';
import type { SessionGraph, StepNode, StepOutcome, TurnNode } from '../../shared/steps';
import { flattenGraph, isUserInput } from '../../shared/steps';
import type { ToolSpan } from '../../shared/metrics';
import { maxDuration, toolSpans } from '../../shared/metrics';
import type { MsgKey } from '../../shared/i18n';
import { TimelineRow } from './TimelineRow';
import { MetricTiming } from './MetricTiming';
import { MetricTokens } from './MetricTokens';
import { useAutoScroll } from '../hooks/useAutoScroll';
import { useT } from '../i18n';
import { formatDuration } from '../format';

/**
 * Step 的收场：符号独立于颜色，灰度下也要能区分（同 §6.3 / F21 的原则）。
 *
 * ★ 符号留在表里、文案换成 key：符号是**排版**，两种语言下都是这三个字形，
 *   进目录只会多一份永远同步不了的复制品。
 */
const OUTCOME: Record<StepOutcome, { symbol: string; labelKey: MsgKey }> = {
  act: { symbol: '▶', labelKey: 'outcome.act' },
  answer: { symbol: '●', labelKey: 'outcome.answer' },
  open: { symbol: '·', labelKey: 'outcome.open' },
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
  const { t } = useT();
  const { scrollRef, onScroll } = useAutoScroll(total, selectedIndex);
  const empty = graph.turns.length === 0 && graph.preamble.length === 0;

  /**
   * F16 的工具耗时（§5）。**在这里算一次，往下传**，理由有两条：
   *   1. 刻度必须是**全会话共用**的一把尺子，否则各 Step 自己归一化，
   *      0.5s 的 apply_patch 会画得和 1.8s 的 exec_command 一样长（见 MetricTiming）。
   *   2. 算的是**全量** entries（`flattenGraph` 把图摊回原序列），
   *      与 §6.8.5 第 3 条同一条纪律：过滤只决定哪些行渲染，
   *      不该让度量跟着变——关掉「行动」组不该把耗时条一起关掉。
   */
  const spans = useMemo(() => {
    const byCall = new Map<string, ToolSpan>();
    for (const s of toolSpans(flattenGraph(graph))) byCall.set(s.callId, s);
    return byCall;
  }, [graph]);
  // 一条都算不出耗时（只有调用没有结果 / 时间戳全缺）→ 没有尺子，整块不画
  const timeScale = useMemo(() => maxDuration([...spans.values()]), [spans]);

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
            {emptyHint ?? t('ui.noMatchingEntries')}
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
            spans={spans}
            timeScale={timeScale}
          />
        ))}

        {/*
         * F17 · 会话级的用量图，摆在**全部 Turn 之后**。
         * 摆到顶上就成了 §6.0 / F5 明确否掉的「摘要卡片区」，
         * 会把第一屏从「这一轮发生了什么」挤成「统计」。
         * 一个 token_count 都没有时它自己返回 null，不占位。
         */}
        {!empty && <MetricTokens graph={graph} />}

        {empty && <p className="sessions-empty">{t('ui.nothingToShow')}</p>}
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
  /** call_id → 耗时（F16）。全会话算一次，见 StepGraph 里的注释 */
  spans: Map<string, ToolSpan>;
  /** 耗时条共用的刻度上限；undefined = 一条都算不出，整块不画 */
  timeScale?: number;
}

/**
 * ★ F15 · 整轮折叠。
 *
 * 和 Turn 前言的折叠（`TurnPreamble`）是**两件事**，别合并：
 * 前言折的是「这一轮开始前灌进去的上下文」，整轮折的是「这一轮我看过了，收起来」。
 * 长会话里翻到第 7 轮时，前 6 轮每轮几十行，没有整轮折叠就只能一路滚。
 *
 * 三条不许改的：
 *   1. **默认展开**。同 §6.8.8：查看器的职责是「摊开」不是「摘要」，
 *      看不见的东西等于不存在。折叠必须由用户主动按。
 *   2. **头和尾留着**。折起来还能看见 `Turn N · 冻结配置 · N step` 和
 *      时长/首字/task_complete——收起的是正文，不是这一轮的身份。
 *   3. **说清藏了几条**（`ui.turnCollapsed`）。悄悄消失就成了数据丢失。
 *
 * ⚠️ 藏起来的条数按**全量**算，不按当前可见的算：口径同 §6.8.5 第 3 条，
 *    这个数字描述的是结构（这一轮有多少条记录），不是过滤器的结果。
 *
 * ⚠️ 折叠状态是每个 Turn 各自的组件内 state，**不持久化**：
 *    它是「我这会儿看完了」的临时表态，不是视图偏好那种长期表态（对比 useViewMode）。
 */
function Turn({ turn, visible, selectedIndex, onSelect, spans, timeScale }: TurnProps) {
  const { t } = useT();
  const [open, setOpen] = useState(true);
  const config = [turn.model, turn.effort, turn.approval, turn.sandbox].filter(Boolean).join(' · ');
  const end = turn.end;

  // 折起来会藏掉多少条：前言 + 每个 Step 的正文与块尾。task_complete 在 Turn 尾，不算
  const hidden =
    turn.preamble.length +
    turn.steps.reduce((n, s) => n + s.entries.length + (s.usage ? 1 : 0), 0);

  return (
    <section
      className="turn"
      data-testid="turn"
      data-turn={turn.no}
      data-status={turn.status}
      data-collapsed={open ? undefined : '1'}
    >
      <header className="turn-head">
        <button
          type="button"
          className="turn-toggle"
          data-testid="turn-toggle"
          aria-expanded={open}
          aria-label={open ? t('ui.collapseTurn') : t('ui.expandTurn')}
          title={open ? t('ui.collapseTurn') : t('ui.expandTurn')}
          onClick={() => setOpen((v) => !v)}
        >
          <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        </button>
        {/* config 是模型名/审批模式这些**纯数据**，原样显示，不进目录 */}
        <span className="turn-no">{t('ui.turnNo', { no: turn.no })}</span>
        {config && <span className="turn-config">{config}</span>}
        <span className="spacer" />
        <span className="turn-steps">{t('ui.stepCount', { n: turn.steps.length })}</span>
      </header>

      {open ? (
        <>
          <TurnPreamble
            entries={turn.preamble}
            visible={visible}
            selectedIndex={selectedIndex}
            onSelect={onSelect}
          />

          <div className="steps">
            {turn.steps.map((step, i) => (
              <Fragment key={step.no}>
                <Step
                  step={step}
                  visible={visible}
                  selectedIndex={selectedIndex}
                  onSelect={onSelect}
                  spans={spans}
                  timeScale={timeScale}
                />
                {i < turn.steps.length - 1 && (
                  <p className="step-link" data-testid="step-link">
                    <span className="step-arrow" aria-hidden="true">
                      ↓
                    </span>
                    {step.outcome === 'act' ? t('ui.stepLinkAct') : t('ui.stepLinkContinue')}
                  </p>
                )}
              </Fragment>
            ))}
            {turn.steps.length === 0 && <p className="step-empty">{t('ui.turnNoOutput')}</p>}
          </div>
        </>
      ) : (
        <p className="turn-collapsed" data-testid="turn-collapsed">
          {t('ui.turnCollapsed', { n: hidden })}
        </p>
      )}

      <footer className="turn-foot">
        {turn.status === 'complete' ? (
          <>
            <span>{formatDuration(turn.durationMs)}</span>
            {turn.ttftMs != null && (
              <span>{t('ui.ttft', { value: formatDuration(turn.ttftMs) })}</span>
            )}
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
          <span className="turn-open">{t('ui.turnOpen')}</span>
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
/**
 * ★ 不再写成 `Omit<TurnProps, 'turn'>`：F16 给 Turn 加了 `spans` / `timeScale`，
 *   前言根本用不到它们，跟着继承只会逼调用方传一份用不上的度量下来。
 *   共享 props 类型省的是几行字，代价是每加一个字段就多一处无谓的耦合。
 */
interface TurnPreambleProps {
  entries: Entry[];
  visible: Set<number>;
  selectedIndex: number | null;
  onSelect: (index: number) => void;
}

function TurnPreamble({ entries, visible, selectedIndex, onSelect }: TurnPreambleProps) {
  const { t } = useT();
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
          {open
            ? t('ui.collapseContext', { n: foldable })
            : t('ui.expandContext', { n: foldable })}
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
  spans: Map<string, ToolSpan>;
  timeScale?: number;
}

const Step = memo(function Step({
  step,
  visible,
  selectedIndex,
  onSelect,
  spans,
  timeScale,
}: StepProps) {
  const { t } = useT();
  const o = OUTCOME[step.outcome];
  const shown = step.entries.filter((e) => visible.has(e.index));
  const filtered = step.entries.length - shown.length;
  const usage = step.usage;

  /**
   * 本步的工具耗时（F16）。挂在**本步全部** entries 上，不是可见的那些——
   * 过滤器不该改变度量（§6.8.5 第 3 条）。
   * 顺序跟着调用出现的顺序走，与块头 `step.tools` 的口径一致。
   */
  const mySpans = step.entries
    .map((e) => (e.kind === 'tool_call' && e.callId ? spans.get(e.callId) : undefined))
    .filter((s): s is ToolSpan => s !== undefined);

  return (
    <article
      className="step"
      data-testid="step"
      data-step={step.no}
      data-outcome={step.outcome}
      data-error={step.hasError || undefined}
    >
      <header className="step-head">
        {/* 圆形节点挂在主干线上，是「图感」的来源；文字给读屏器 */}
        <span className="step-node" aria-hidden="true">
          {step.no}
        </span>
        <span className="step-no">{t('ui.stepNo', { no: step.no })}</span>
        {/*
         * ★ `step.tools` 是**裸工具名**（`exec_command`），箭头在这里补。
         *   数据层只记「调了谁」，`→` 是排版决定——它跟时间线上工具调用行的
         *   标题共用 `entry.toolCall` 这一条 key，两处的样子才不会各走各的。
         */}
        {step.tools.length > 0 && (
          <span className="step-tools">
            {step.tools
              // 名字缺失时 `tools` 里是空串（条目数要与 tool_call 一一对应，
              // 不能过滤掉——`outcomeOf` 靠它的长度判「这一步调没调工具」）。
              // 空名走「无名工具」那条完整文案，别渲染出一个空 chip。
              .map((tool) => (tool ? t('entry.toolCall', { tool }) : t('entry.toolCallUnnamed')))
              .join(' · ')}
          </span>
        )}
        <span className="spacer" />
        <span className={`step-outcome o-${step.outcome}`}>
          <span aria-hidden="true">{o.symbol}</span> {t(o.labelKey)}
        </span>
      </header>

      <div className="step-body">
        {groupBranches(shown).map((g) =>
          g.branch ? (
            // ★ 支线：出去调工具、带着结果回来。ReAct 里最有形状的一步，
            //   画成从主线支出去的一段缩进，比上下两行相邻读得出来得多。
            <div className="branch" key={g.items[0].index} data-testid="branch">
              <Rows entries={g.items} visible={visible} sel={selectedIndex} onSelect={onSelect} />
            </div>
          ) : (
            <Rows
              key={g.items[0].index}
              entries={g.items}
              visible={visible}
              sel={selectedIndex}
              onSelect={onSelect}
            />
          ),
        )}
        {filtered > 0 && <p className="step-filtered">{t('ui.filteredOut', { n: filtered })}</p>}
        {step.entries.length === 0 && <p className="step-filtered">{t('ui.stepNoOutput')}</p>}
      </div>

      {/*
       * F16 · 耗时条摆在正文之下、用量之上：支线里每一行都得守着 §6.0 的
       * 固定单行高，把条子塞进去会把行撑破（F2/F3）。
       * `timeScale` 为 undefined = 全会话一条耗时都算不出来 → 整块不画。
       */}
      {timeScale !== undefined && <MetricTiming spans={mySpans} max={timeScale} />}

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

/**
 * 把连续的「工具调用 / 工具结果」并成一段支线。
 *
 * 只按 kind 分段、不去配 `call_id`：一个 Step 里可能有多个工具调用，
 * 而 rollout 并不保证 call 与 output 严格交替（失败的调用可能没有 output）。
 * 按连续段分组对乱序和缺失都免疫，最坏结果只是一段支线里装了两次往返——
 * 仍然比摆成平铺的四行读得出来。
 */
function groupBranches(entries: Entry[]): { branch: boolean; items: Entry[] }[] {
  const out: { branch: boolean; items: Entry[] }[] = [];
  for (const e of entries) {
    const branch = e.kind === 'tool_call' || e.kind === 'tool_out';
    const last = out[out.length - 1];
    if (last && last.branch === branch) last.items.push(e);
    else out.push({ branch, items: [e] });
  }
  return out;
}

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
