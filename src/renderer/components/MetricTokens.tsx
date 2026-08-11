/**
 * F17 · Token 用量图：每个 Step 一根柱，**默认画单步增量**，可切到累计值。
 *
 * ── ★ 反直觉的实测事实：`total_token_usage` 是会话累计值 ────────────────
 * 夹具 04 的八条 `token_count` 依次是 11840 → 24800 → … → 128620，单调递增，
 * 因为字段名就叫 **total**。直接把它画成柱状图，会得到一条永远向上的斜线，
 * 看起来「每一步都在暴涨」，其实只是累计量在累计——**图会骗人**。
 * 所以默认画 `deltaInput` / `deltaOutput`（做差得到的单步增量），
 * 并且把 `ui.tokenCumulativeNote` **常显**在图旁边：
 * 用户迟早会把这里的数字和详情面板里那条 `token_count` 的原文对照，
 * 对不上的时候必须当场有解释，而不是让他以为哪边算错了。
 *
 * ── ★ 增量可能是负的，不许夹到 0 ───────────────────────────────────
 * 会话被 compact 压缩后计数会回落。负值本身就是「这里发生过一次压缩」的信号，
 * 抹平成 0 等于把唯一的线索删掉。柱长按绝对值给，符号靠数字和 `data-sign` 表达。
 *
 * ── ★ 输入和输出共用一把尺子 ────────────────────────────────────────
 * 实测输入增量是输出的 30 倍上下（20360 vs 640），共用刻度会让输出的柱子很短。
 * 那是**事实**，不是渲染 bug：一条 rollout 的开销几乎全在重复回灌的历史上。
 * 两把尺子会让「输出也很贵」这个错觉成立，所以宁可短——精确数字就印在柱子旁边，
 * 要读具体值永远不必去量长度。
 *
 * ── 位置为什么在图的**最后** ────────────────────────────────────────
 * 摆到顶上就成了 §6.0 / F5 明确否掉的「摘要卡片区」，会把主区第一屏从
 * 「这一轮发生了什么」挤成「统计」。而且它是会话级的东西，读完全部 Turn
 * 再看它才对得上号。
 */
import { useMemo, useState } from 'react';
import type { SessionGraph } from '../../shared/steps';
import { maxDelta, maxTotal, tokenSeries, type TokenPoint } from '../../shared/metrics';
import { useT } from '../i18n';
import { MetricBar } from './MetricBar';

type Mode = 'delta' | 'total';

export interface MetricTokensProps {
  /** 从**全量** entries 切出来的图；过滤器不参与，理由同 §6.8.5 第 3 条 */
  graph: SessionGraph;
}

/** 累计模式的刻度上限。shared/metrics 只给了增量的（`maxDelta`），这里按同样的口径补一个 */
export function MetricTokens({ graph }: MetricTokensProps) {
  const { t } = useT();
  const [mode, setMode] = useState<Mode>('delta');
  const series = useMemo(() => tokenSeries(graph), [graph]);

  const scale = mode === 'delta' ? maxDelta(series) : maxTotal(series);
  /**
   * 一个 token_count 都没有的会话（末轮被中断、或整份文件都没走到用量上报）
   * 画不出任何一根柱——此时**整块不画**，而不是画一排空槽。
   * 空槽会被读成「用量是 0」，那是彻头彻尾的假话。
   */
  if (scale === undefined || !(scale > 0)) return null;

  const value = (p: TokenPoint, which: 'input' | 'output'): number | undefined => {
    if (mode === 'delta') return which === 'input' ? p.deltaInput : p.deltaOutput;
    return which === 'input' ? p.totalInput : p.totalOutput;
  };

  return (
    <section className="token-chart" data-testid="token-chart" data-mode={mode}>
      <header className="token-head">
        <span className="token-title">{t('ui.tokenUsage')}</span>
        <span className="token-modes">
          <button
            type="button"
            className="token-mode"
            aria-pressed={mode === 'delta'}
            data-testid="token-mode-delta"
            onClick={() => setMode('delta')}
          >
            {t('ui.tokenPerStep')}
          </button>
          <button
            type="button"
            className="token-mode"
            aria-pressed={mode === 'total'}
            data-testid="token-mode-total"
            onClick={() => setMode('total')}
          >
            {t('ui.tokenCumulative')}
          </button>
        </span>
        <span className="spacer" />
        <span className="token-legend">
          <span className="swatch t-input" aria-hidden="true" />
          {t('ui.inputTokens')}
          <span className="swatch t-output" aria-hidden="true" />
          {t('ui.outputTokens')}
        </span>
      </header>

      {/* ★ 常显，不是 tooltip：见文件头「图会骗人」那段 */}
      <p className="token-note" data-testid="token-note">
        {t('ui.tokenCumulativeNote')}
      </p>

      <ol className="token-rows">
        {series.map((p) => (
          <li
            className="token-row"
            data-testid="token-row"
            data-turn={p.turnNo}
            data-step={p.stepNo}
            key={`${p.turnNo}-${p.stepNo}`}
          >
            <span className="token-label">
              {t('ui.turnNo', { no: p.turnNo })} · {t('ui.stepNo', { no: p.stepNo })}
            </span>
            <Cell v={value(p, 'input')} scale={scale} tone="input" />
            <Cell v={value(p, 'output')} scale={scale} tone="output" />
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * 一格：柱 + 数字。
 *
 * `v` 为 undefined 的 Step（末轮被中断，等不到 `token_count`）画 `—` 而不是空柱，
 * 口径同 F16：**0 和「不知道」必须分得开**。
 */
function Cell({
  v,
  scale,
  tone,
}: {
  v: number | undefined;
  scale: number;
  tone: 'input' | 'output';
}) {
  if (v === undefined) {
    return (
      <span className="token-cell" data-testid="token-cell">
        <span className="metric-track" aria-hidden="true" />
        <span className="token-val token-missing">—</span>
      </span>
    );
  }
  return (
    <span className="token-cell" data-testid="token-cell">
      <MetricBar ratio={Math.abs(v) / scale} tone={tone} negative={v < 0} testId="token-bar" />
      {/* 负号照实印出来——它是「这里被 compact 压缩过」的唯一线索 */}
      <span className="token-val" data-sign={v < 0 ? 'neg' : 'pos'}>
        {v}
      </span>
    </span>
  );
}
