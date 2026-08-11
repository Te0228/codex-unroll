/**
 * F16 · 工具耗时条：每个工具调用一条横条，长度 = `durationMs / 全会话最长的那条`。
 *
 * ── ★ 尺子是**全会话共用**的，不是每个 Step 各自归一化 ────────────────
 * 条形图唯一的用处是「互相比」。要是每个 Step 都拿自己最长的那条当 100%，
 * 一个只调了一次 `apply_patch`（0.5s）的 Step 会画出一条满格的条，
 * 看起来跟隔壁跑了 1.8s 的 `exec_command` 一样久——比出来的结论是反的。
 * 所以刻度上限由 StepGraph 在**全量** entries 上算一次（`maxDuration`），传下来。
 * 这同时满足 §6.8.5 第 3 条：**结构与度量都不随过滤器变形**，
 * 过滤只决定哪些行渲染，不该让条子的长度跟着变。
 *
 * ── ★ 算不出耗时的，绝不画成 0 宽的条 ──────────────────────────────
 * 「0ms」和「不知道」是两件事，画成同一根零宽的条会被读成「瞬间完成」。
 * 两种拿不到的情况文案还不一样，因为对用户意味着的事不一样：
 *   · 只有调用没有结果 → `ui.stillRunning`「还没有结果」——被中断，或正在跟随
 *   · 有结果但时间戳缺/坏 → `ui.noTiming`「算不出耗时」——数据本身残缺
 * 一条都算不出来时（`maxDuration` 为 undefined）整块**不画**，
 * 这个判断在 StepGraph 那边做：没有尺子就没有条形图可言。
 *
 * 位置定在 Step 尾（正文之下、用量之上）而不是支线旁边：支线里每一行都得
 * 守着 §6.0 的固定单行高，塞一根条进去就会把行撑破（F2/F3）。
 */
import type { ToolSpan } from '../../shared/metrics';
import { formatDuration } from '../format';
import { useT } from '../i18n';
import { MetricBar } from './MetricBar';

export interface MetricTimingProps {
  /** 本 Step 里的工具调用，按出现顺序。来自全量 entries，不受过滤影响 */
  spans: ToolSpan[];
  /** 全会话共用的刻度上限（毫秒），必须 > 0 才有意义 */
  max: number;
}

export function MetricTiming({ spans, max }: MetricTimingProps) {
  const { t } = useT();
  if (spans.length === 0 || !(max > 0)) return null;

  return (
    <div className="step-timing" data-testid="step-timing">
      <p className="timing-title">{t('ui.toolTiming')}</p>
      {spans.map((s) => {
        const tool = s.tool || t('entry.toolCallUnnamed');
        // 先取出来再判断，narrowing 才管用——`s.durationMs` 在闭包里不会被收窄
        const d = s.durationMs;
        const value = formatDuration(d);
        return (
          <p
            className="timing-row"
            data-testid="timing-row"
            key={s.callId}
            // 条是 aria-hidden 的装饰，整行的意思靠这句话说全（读屏器与 tooltip 共用）
            title={d === undefined ? tool : t('ui.toolTook', { tool, value })}
          >
            <span className="timing-tool">{tool}</span>
            {d !== undefined ? (
              <>
                <MetricBar ratio={d / max} tone="act" testId="timing-bar" />
                <span className="timing-value">{value}</span>
              </>
            ) : (
              /* 没有条，只有一句话——空槽会被误读成「零耗时」，比不画更糟 */
              <span className="timing-note" data-testid="timing-note">
                {s.output ? t('ui.noTiming') : t('ui.stillRunning')}
              </span>
            )}
          </p>
        );
      })}
    </div>
  );
}
