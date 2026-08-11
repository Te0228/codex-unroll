/**
 * 图上所有条形图共用的最小单元：一条按比例填充的横条（F16 耗时 / F17 用量）。
 *
 * ── ★ 宽度为什么走 CSSOM，而不是 JSX 的行内 style 属性 ────────────────
 * 生产 CSP 是 `style-src 'self'`：**由 HTML 解析出来的 style 属性会被浏览器
 * 直接拒掉**，而脚本通过 CSSOM 写的不受这条限制（同 `useResizable` 的做法）。
 * 更坏的是开发模式下 CSP 宽松，把宽度写成行内 style 一路看不出问题，
 * 只有打包产物才炸——所以 `global.css.test.ts` 有一条扫描 `src/renderer`
 * 全目录的回归断言顶着（正则直接搜源码文本，连注释里都不许出现那个写法），
 * 这里也别开例外。
 *
 * ── ★ 这一层不区分「0」和「不知道」 ─────────────────────────────────
 * 区分是**调用方**的职责：拿不到数值时根本不该渲染 MetricBar
 * （F16 的 `stillRunning` / `noTiming` 分支就是干这个的）。
 * 到得了这里的都是真实数值，`ratio === 0` 就老老实实画成空槽。
 * 反过来，为了让「很小但不是 0」看得见，非零的条有一个 2px 的最小宽度，
 * 所以 `data-zero` 必须打准——它是「最小宽度不适用于我」的唯一开关。
 *
 * ── ★ 负值不取巧 ───────────────────────────────────────────────────
 * token 增量在会话被 compact 压缩后会回落成负数（见 shared/metrics.ts 文件头）。
 * 这里按**绝对值**给长度，另外打一个 `data-sign="neg"`：颜色之外还有一个
 * 独立于颜色的标记，灰度下也分得开（同 §6.3 / F21 的原则）。
 * 精确数值由调用方印在条子旁边，条本身是 `aria-hidden` 的装饰。
 */
import { useLayoutEffect, useRef } from 'react';

export interface MetricBarProps {
  /** 已归一化的填充比例。>1 会被钳到 1，负号请走 `negative`，不要传负的 ratio */
  ratio: number;
  /** 语义配色分组，落到 class 上（颜色只写在 CSS 里，见文件头） */
  tone: 'act' | 'input' | 'output';
  /** 这个值本身是负数（token 增量回落）。长度仍按绝对值给，不夹到 0 */
  negative?: boolean;
  /** 测试与断言的抓手；不同图各用各的名字，免得断言互相串 */
  testId?: string;
}

export function MetricBar({ ratio, tone, negative = false, testId = 'metric-bar' }: MetricBarProps) {
  const ref = useRef<HTMLSpanElement>(null);
  // 非有限数（比如上层不小心传了 0/0）一律当 0：宁可画空槽，也不要画出一条 NaN 宽的条
  const pct = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) * 100 : 0;

  useLayoutEffect(() => {
    ref.current?.style.setProperty('--w', `${pct.toFixed(2)}%`);
  }, [pct]);

  return (
    <span className="metric-track" aria-hidden="true">
      <span
        ref={ref}
        className={`metric-fill t-${tone}`}
        data-testid={testId}
        {...(pct === 0 ? { 'data-zero': '1' } : {})}
        {...(negative ? { 'data-sign': 'neg' } : {})}
      />
    </span>
  );
}
