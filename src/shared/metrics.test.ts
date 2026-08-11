/**
 * SPEC §14.10 M 组：耗时与 token 用量（F16 / F17）。
 *
 * 期望值从 test/fixtures/ 实测算出。
 * **实现与期望值对不上，是实现错了，不要改期望值。**
 *
 * 这一组有两条是**防止画出骗人的图**的：
 *   · M6：`total_token_usage` 是会话累计值，直接画会得到一条永远向上的斜线，
 *     看着像每步暴涨，其实只是累计量。必须做差。
 *   · M3：算不出耗时时必须是 `undefined` 而不是 0——
 *     0 宽的条会被读成「瞬间完成」，那是编造数据。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { toEntries } from './rollout';
import { buildGraph } from './steps';
import { maxDelta, maxDuration, maxTotal, timeMs, tokenSeries, toolSpans } from './metrics';
import type { Entry } from './types';

function fixture(name: string): Entry[] {
  const path = fileURLToPath(new URL(`../../test/fixtures/${name}`, import.meta.url));
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return toEntries(lines);
}

const synth = (records: unknown[]): Entry[] => toEntries(records.map((r) => JSON.stringify(r)));

const call = (id: string, at?: string, name = 'shell') => ({
  ...(at ? { timestamp: at } : {}),
  type: 'response_item',
  payload: { type: 'function_call', call_id: id, name, arguments: '{}' },
});
const output = (id: string, at?: string) => ({
  ...(at ? { timestamp: at } : {}),
  type: 'response_item',
  payload: { type: 'function_call_output', call_id: id, output: 'ok' },
});

// ─────────────────────────────────────────────────────────────
describe('§14.10 M 组：工具耗时', () => {
  const spans = toolSpans(fixture('04-multi-turn.jsonl'));

  it('M1 夹具 04 的 7 次调用全部算得出耗时', () => {
    expect(spans).toHaveLength(7);
    expect(spans.every((s) => s.durationMs !== undefined)).toBe(true);
  });

  it('M2 耗时是实测值：exec_command 1800ms，apply_patch 500ms', () => {
    const byTool = new Map(spans.map((s) => [s.callId, s]));
    expect(byTool.get('call_lf_0001')?.tool).toBe('exec_command');
    expect(byTool.get('call_lf_0001')?.durationMs).toBe(1800);
    expect(byTool.get('call_lf_0003')?.tool).toBe('apply_patch');
    expect(byTool.get('call_lf_0003')?.durationMs).toBe(500);
    expect(maxDuration(spans)).toBe(1800);
  });

  /**
   * ★ M3 是这一组最重要的一条。0 和「不知道」必须分得开：
   * 画成 0 宽的条 = 告诉用户「这个工具瞬间就完成了」，那是编造。
   */
  describe('M3 算不出耗时时是 undefined，不是 0', () => {
    it('只有调用没有结果（被中断 / 正在跟随）', () => {
      const s = toolSpans(synth([call('c1', '2026-08-10T09:00:00.000Z')]))[0];
      expect(s.output).toBeUndefined();
      expect(s.durationMs).toBeUndefined();
      expect(s.durationMs).not.toBe(0);
    });

    it('缺时间戳', () => {
      const s = toolSpans(synth([call('c1'), output('c1')]))[0];
      expect(s.startMs).toBeUndefined();
      expect(s.durationMs).toBeUndefined();
    });

    it('时间戳解析不出来', () => {
      const s = toolSpans(synth([call('c1', '不是时间'), output('c1', '也不是')]))[0];
      expect(s.durationMs).toBeUndefined();
    });

    it('结果早于调用（时钟回拨这类脏数据）也不给负耗时', () => {
      const s = toolSpans(
        synth([call('c1', '2026-08-10T09:00:05.000Z'), output('c1', '2026-08-10T09:00:01.000Z')]),
      )[0];
      expect(s.durationMs).toBeUndefined();
    });

    it('一条都算不出时 maxDuration 是 undefined——上层据此整块不画', () => {
      expect(maxDuration(toolSpans(synth([call('c1')])))).toBeUndefined();
      expect(maxDuration([])).toBeUndefined();
    });
  });

  it('M4 只有结果没有调用 → 画不出条，跳过（条目本身在 UI 上照常显示）', () => {
    expect(toolSpans(synth([output('c1', '2026-08-10T09:00:01.000Z')]))).toHaveLength(0);
  });

  it('M4b 工具名取不到时是空字符串，不崩也不显示 undefined', () => {
    // title 正常是 { key:'entry.toolCall', params:{tool} }（§15 的 Text）。
    // 缺 name 字段时归一化会给别的形状——这里只要求不炸、不把 'undefined' 显给用户。
    const es = synth([
      { timestamp: '2026-08-10T09:00:00.000Z', type: 'response_item',
        payload: { type: 'function_call', call_id: 'c9', arguments: '{}' } },
      { timestamp: '2026-08-10T09:00:01.000Z', type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'c9', output: 'ok' } },
    ]);
    const s = toolSpans(es)[0];
    expect(typeof s.tool).toBe('string');
    expect(s.tool).not.toContain('undefined');
    expect(s.durationMs).toBe(1000);
  });

  it('M5 timeMs：缺失/非法一律 undefined，不用 0 兜底', () => {
    expect(timeMs(undefined)).toBeUndefined();
    const [noTs, badTs, okTs] = synth([
      { type: 'event_msg', payload: { type: 'user_message', message: 'a' } },
      { timestamp: '不是时间', type: 'event_msg', payload: { type: 'user_message', message: 'b' } },
      {
        timestamp: '2026-08-10T09:00:00.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'c' },
      },
    ]);
    expect(timeMs(noTs)).toBeUndefined();
    expect(timeMs(badTs)).toBeUndefined();
    expect(timeMs(okTs)).toBe(Date.parse('2026-08-10T09:00:00.000Z'));
  });
});

// ─────────────────────────────────────────────────────────────
describe('§14.10 M 组：token 用量', () => {
  const series = tokenSeries(buildGraph(fixture('04-multi-turn.jsonl')));

  /**
   * ★ M6：夹具 04 的八条 token_count 依次是
   *   11840 → 24800 → 38720 → 54020 → 70760 → 88780 → 108260 → 128620
   * 单调递增，因为字段名就叫 **total**。这条钉住「累计 ≠ 单步」。
   */
  it('M6 累计值原样保留，同时给出做差后的单步增量', () => {
    expect(series.map((p) => p.totalInput)).toEqual([
      11840, 24800, 38720, 54020, 70760, 88780, 108260, 128620,
      undefined, // 末轮没有 token_count（open 态）
    ]);
    expect(series.map((p) => p.deltaInput)).toEqual([
      11840, 12960, 13920, 15300, 16740, 18020, 19480, 20360, undefined,
    ]);
    // 第一个点的增量就等于它本身——前面没有基线
    expect(series[0].deltaInput).toBe(series[0].totalInput);
  });

  it('M7 输出侧同理', () => {
    expect(series.map((p) => p.totalOutput)).toEqual([
      214, 402, 804, 1290, 1522, 1880, 2076, 2716, undefined,
    ]);
    expect(series.map((p) => p.deltaOutput)).toEqual([
      214, 188, 402, 486, 232, 358, 196, 640, undefined,
    ]);
  });

  it('M8 每个点标出它属于哪个 Turn 的第几个 Step', () => {
    expect(series.map((p) => `${p.turnNo}-${p.stepNo}`)).toEqual([
      '1-1', '1-2', '1-3',
      '2-1', '2-2', '2-3', '2-4', '2-5',
      '3-1',
    ]);
  });

  /**
   * ★ M9：累计读数**可能回落**，做差得到负数，不许夹到 0。
   *
   * 机制已在 Codex 源码核实：`append_last_usage` 是 `add_assign`（单调递增），
   * 但 `fill_to_context_window` 会整体替换 `total_token_usage`，
   * 只填 `total_tokens`、把 input/output 归零（protocol/src/protocol.rs:2122 与 2127）。
   * 抹掉负值等于把「这里发生过一次重置」这个信号删掉。
   */
  it('M9 累计读数回落时负增量照实保留，不夹到 0', () => {
    const es = synth([
      { type: 'turn_context', payload: { turn_id: 't1', model: 'm' } },
      { type: 'response_item', payload: { type: 'reasoning', content: 'a' } },
      {
        type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 90000, output_tokens: 500 } } },
      },
      { type: 'response_item', payload: { type: 'reasoning', content: 'b' } },
      // 读数回落（fill_to_context_window 把 input/output 归零后重新累加）
      {
        type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 12000, output_tokens: 80 } } },
      },
    ]);
    const s = tokenSeries(buildGraph(es));
    expect(s.map((p) => p.deltaInput)).toEqual([90000, -78000]);
    expect(s.map((p) => p.deltaOutput)).toEqual([500, -420]);
    // 纵轴上限取绝对值，否则负的那根柱子会画到框外
    expect(maxDelta(s)).toBe(90000);
  });

  it('M10 一个 token_count 都没有 → 序列仍在（Step 骨架不变），但没有数值', () => {
    const es = synth([
      { type: 'turn_context', payload: { turn_id: 't1', model: 'm' } },
      { type: 'response_item', payload: { type: 'reasoning', content: 'a' } },
    ]);
    const s = tokenSeries(buildGraph(es));
    expect(s).toHaveLength(1);
    expect(s[0].totalInput).toBeUndefined();
    expect(s[0].deltaInput).toBeUndefined();
    // 上层据此整块不画，而不是画一排 0
    expect(maxDelta(s)).toBeUndefined();
  });

  it('M10b maxTotal 是累计模式的纵轴上限，与 maxDelta 走同一套口径', () => {
    const s = tokenSeries(buildGraph(fixture('04-multi-turn.jsonl')));
    // 累计模式的上限就是最后那个累计值
    expect(maxTotal(s)).toBe(128620);
    // 增量模式小得多——这正是「不能拿累计值当曲线画」的直观证据：
    // 同一份数据，两种口径的量级差一个数量级
    expect(maxDelta(s)).toBe(20360);
    expect(maxTotal([])).toBeUndefined();
  });

  it('M11 空图不崩', () => {
    expect(tokenSeries(buildGraph([]))).toEqual([]);
    expect(maxDelta([])).toBeUndefined();
  });

  it('M12 夹具 01 的两个 Step：增量与 §14.2 C11 的会话合计对得上', () => {
    const s = tokenSeries(buildGraph(fixture('01-apply-patch-rejected.jsonl')));
    expect(s.map((p) => p.totalInput)).toEqual([16986, 34188]);
    expect(s.map((p) => p.deltaInput)).toEqual([16986, 17202]);
    expect(s.map((p) => p.totalOutput)).toEqual([187, 263]);
    expect(s.map((p) => p.deltaOutput)).toEqual([187, 76]);
  });
});
