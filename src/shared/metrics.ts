/**
 * 图上的两组量化视图（SPEC §5 F16 / F17）：工具耗时条 与 token 用量。
 *
 * ══ ★ 反直觉的实测事实：`total_token_usage` 是**会话累计值** ══════════
 *
 * 夹具 04 的八条 `token_count` 依次是：
 *
 *   11840 → 24800 → 38720 → 54020 → 70760 → 88780 → 108260 → 128620
 *
 * 单调递增，因为字段名就叫 **total**。所以：
 *   · 想画「这一步烧了多少」必须**做差**，直接画会得到一条永远向上的斜线，
 *     看着像每步都在暴涨，其实只是累计量。
 *   · 第一个 Step 的增量就等于它本身（前面没有基线）。
 *   · 做差可能得到负数（会话被压缩 compact 后计数会回落）——**不夹到 0**，
 *     负值本身就是「发生过压缩」的信号，抹掉等于骗人。上层照实显示。
 *
 * ══ 耗时怎么算 ═══════════════════════════════════════════════════════
 *
 * 工具耗时 = 结果条目的时间戳 − 调用条目的时间戳，靠 `call_id` 配对（见 pairing.ts）。
 * 实测夹具 04：`exec_command` 约 1.8s，`apply_patch` 约 0.5s——量级合理。
 *
 * 三种拿不到耗时的情况，一律返回 `undefined` 而不是 0：
 *   · 只有调用没有结果（被中断 / 正在跟随）
 *   · 任一侧缺时间戳（§14.2 A9：缺失时是空字符串）
 *   · 时间戳解析不出来
 * **0 和「不知道」必须分得开**——画成一条零宽的条会被读成「瞬间完成」。
 */
import type { Entry } from './types';
import type { SessionGraph } from './steps';
import { buildPairs } from './pairing';

// ─────────────────────────────────────────────────────────────
// 时间
// ─────────────────────────────────────────────────────────────

/** ISO 时间戳 → epoch 毫秒。缺失/非法一律 undefined，不用 0 兜底。 */
export function timeMs(e: Entry | undefined): number | undefined {
  if (!e?.timestamp) return undefined;
  const t = Date.parse(e.timestamp);
  return Number.isNaN(t) ? undefined : t;
}

export interface ToolSpan {
  callId: string;
  /** 裸工具名，不带箭头——箭头是排版（同 StepNode.tools 的口径） */
  tool: string;
  call: Entry;
  output?: Entry;
  startMs?: number;
  endMs?: number;
  /** 配不上对家、或任一侧没有可用时间戳时为 undefined，**不是 0** */
  durationMs?: number;
}

function toolNameOf(e: Entry): string {
  // title 是 Text：工具调用是 { key: 'entry.toolCall', params: { tool } }
  const t = e.title as { params?: { tool?: unknown } } | string;
  if (typeof t === 'object' && t !== null && typeof t.params?.tool === 'string') {
    return t.params.tool;
  }
  return '';
}

/** 按出现顺序列出本会话的所有工具调用及其耗时。 */
export function toolSpans(entries: Entry[]): ToolSpan[] {
  const out: ToolSpan[] = [];
  for (const p of buildPairs(entries).values()) {
    if (!p.call) continue; // 只有结果没有调用：画不出条，跳过（条目本身在 UI 上照常显示）
    const startMs = timeMs(p.call);
    const endMs = timeMs(p.output);
    const durationMs =
      startMs !== undefined && endMs !== undefined && endMs >= startMs ? endMs - startMs : undefined;
    out.push({
      callId: p.callId,
      tool: toolNameOf(p.call),
      call: p.call,
      ...(p.output ? { output: p.output } : {}),
      ...(startMs === undefined ? {} : { startMs }),
      ...(endMs === undefined ? {} : { endMs }),
      ...(durationMs === undefined ? {} : { durationMs }),
    });
  }
  return out;
}

/**
 * 一组耗时条共用的刻度上限：最长的那条。
 * 返回 `undefined` 表示一条都算不出耗时——上层此时**不该画图**，
 * 而不是画一堆零宽的条。
 */
export function maxDuration(spans: ToolSpan[]): number | undefined {
  const ds = spans.map((s) => s.durationMs).filter((d): d is number => d !== undefined);
  return ds.length === 0 ? undefined : Math.max(...ds);
}

// ─────────────────────────────────────────────────────────────
// Token
// ─────────────────────────────────────────────────────────────

export interface TokenPoint {
  turnNo: number;
  stepNo: number;
  /** 会话累计值，直接取自 total_token_usage */
  totalInput?: number;
  totalOutput?: number;
  /** 相对上一个有数据的点的增量；首个点等于累计值本身 */
  deltaInput?: number;
  deltaOutput?: number;
}

/**
 * 把图上每个 Step 的用量摊成一条序列，**同时给出累计值和单步增量**。
 *
 * 两个都给是刻意的：累计值回答「这个会话烧了多少」，
 * 增量回答「哪一步最贵」。只给累计的话第二个问题根本看不出来。
 */
export function tokenSeries(graph: SessionGraph): TokenPoint[] {
  const out: TokenPoint[] = [];
  let prevIn: number | undefined;
  let prevOut: number | undefined;

  for (const turn of graph.turns) {
    for (const step of turn.steps) {
      const totalInput = step.inputTokens;
      const totalOutput = step.outputTokens;
      const point: TokenPoint = { turnNo: turn.no, stepNo: step.no };

      if (totalInput !== undefined) {
        point.totalInput = totalInput;
        point.deltaInput = prevIn === undefined ? totalInput : totalInput - prevIn;
        prevIn = totalInput;
      }
      if (totalOutput !== undefined) {
        point.totalOutput = totalOutput;
        point.deltaOutput = prevOut === undefined ? totalOutput : totalOutput - prevOut;
        prevOut = totalOutput;
      }
      out.push(point);
    }
  }
  return out;
}

/**
 * 图表的纵轴上限。没有任何数据时返回 undefined——上层不该画。
 *
 * 两个都取**绝对值**：增量可能为负（见本文件头），
 * 不取绝对值的话负的那根柱子会画到框外。
 */
export function maxDelta(series: TokenPoint[]): number | undefined {
  return maxOf(series.flatMap((p) => [p.deltaInput, p.deltaOutput]));
}

/** 同上，但用于「累计」模式的纵轴上限。 */
export function maxTotal(series: TokenPoint[]): number | undefined {
  return maxOf(series.flatMap((p) => [p.totalInput, p.totalOutput]));
}

function maxOf(values: (number | undefined)[]): number | undefined {
  const vs = values.filter((v): v is number => v !== undefined).map((v) => Math.abs(v));
  return vs.length === 0 ? undefined : Math.max(...vs);
}
