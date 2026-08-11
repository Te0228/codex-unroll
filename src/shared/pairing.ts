/**
 * 工具调用配对（SPEC §5 F14）：`call_id` 把「发起调用」和「拿到结果」串起来。
 *
 * 两条工具路径的 payload.type 不同，但 `call_id` 的位置是一样的：
 *
 *   function_call        → function_call_output          （参数是 JSON 字符串）
 *   custom_tool_call     → custom_tool_call_output       （参数是纯文本 patch）
 *
 * ── 三种「配不上」的情况都必须活下来（§3.4）─────────────────────────
 *   · **只有调用没有结果**——被中断、或会话正在跟随中还没写回来。
 *     这是 rollout 里最常见的半截状态，不是坏数据。
 *   · **只有结果没有调用**——从中间截断的文件。
 *   · **同一个 call_id 出现多次**——不该发生，但真发生了也不能崩。
 *     取**第一条**作为代表，其余记进 `extras` 供上层提示，绝不静默丢弃。
 *
 * 没有 `call_id` 的工具条目（旧格式或字段缺失）根本不进配对表——
 * 它们在 UI 上照常显示，只是不提供互跳。
 */
import type { Entry } from './types';

/** 一对调用/结果。两侧都可能缺，但不会两侧都缺。 */
export interface CallPair {
  callId: string;
  /** function_call / custom_tool_call */
  call?: Entry;
  /** function_call_output / custom_tool_call_output */
  output?: Entry;
  /**
   * 同一个 call_id 的多余条目（正常数据里恒为空）。
   * 留着是为了「绝不丢弃」——UI 可以据此提示「这个 call_id 有重复」。
   */
  extras: Entry[];
}

const isCall = (e: Entry) => e.kind === 'tool_call';
const isOutput = (e: Entry) => e.kind === 'tool_out';

/**
 * 建配对表。键是 `call_id`，顺序按**首次出现**——
 * 这样上层直接 `[...pairs.values()]` 拿到的就是时间顺序。
 */
export function buildPairs(entries: Entry[]): Map<string, CallPair> {
  const pairs = new Map<string, CallPair>();
  for (const e of entries) {
    if (!e.callId) continue;
    if (!isCall(e) && !isOutput(e)) continue;

    let p = pairs.get(e.callId);
    if (!p) {
      p = { callId: e.callId, extras: [] };
      pairs.set(e.callId, p);
    }

    if (isCall(e)) {
      if (p.call) p.extras.push(e);
      else p.call = e;
    } else if (p.output) p.extras.push(e);
    else p.output = e;
  }
  return pairs;
}

/**
 * 给一条工具条目找它的对家：调用 ⇄ 结果。
 *
 * 返回 `undefined` 表示「配不上」——UI 该把跳转按钮**藏起来**，
 * 而不是显示一个点了没反应的按钮。
 */
export function counterpart(pairs: Map<string, CallPair>, entry: Entry): Entry | undefined {
  if (!entry.callId) return undefined;
  const p = pairs.get(entry.callId);
  if (!p) return undefined;
  if (isCall(entry)) return p.output;
  if (isOutput(entry)) return p.call;
  return undefined;
}

/** 配得上对家的条目才值得画跳转按钮 */
export function hasCounterpart(pairs: Map<string, CallPair>, entry: Entry): boolean {
  return counterpart(pairs, entry) !== undefined;
}
