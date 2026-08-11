/**
 * SPEC §14.10 P 组：工具调用配对（F14）。
 *
 * 期望值从 test/fixtures/ 实测算出。
 * **实现与期望值对不上，是实现错了，不要改期望值。**
 *
 * 这一组的重点全在「配不上」的三种情况——正常配对是最容易写对的那部分，
 * 而 rollout 里半截状态（只有调用没有结果）恰恰是最常见的。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { toEntries } from './rollout';
import { buildPairs, counterpart, hasCounterpart } from './pairing';
import type { Entry } from './types';

function fixture(name: string): Entry[] {
  const path = fileURLToPath(new URL(`../../test/fixtures/${name}`, import.meta.url));
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return toEntries(lines);
}

const synth = (records: unknown[]): Entry[] => toEntries(records.map((r) => JSON.stringify(r)));

const call = (id: string, name = 'shell') => ({
  timestamp: '2026-08-10T09:00:00.000Z',
  type: 'response_item',
  payload: { type: 'function_call', call_id: id, name, arguments: '{}' },
});
const output = (id: string, at = '2026-08-10T09:00:01.500Z') => ({
  timestamp: at,
  type: 'response_item',
  payload: { type: 'function_call_output', call_id: id, output: 'ok' },
});

describe('§14.10 P 组：call_id 配对', () => {
  it('P1 夹具 01：custom_tool_call 与它的 output 配成一对', () => {
    const es = fixture('01-apply-patch-rejected.jsonl');
    const pairs = buildPairs(es);
    expect(pairs.size).toBe(1);
    const p = [...pairs.values()][0];
    expect(p.callId).toBe('call_00_VGd9DAeHsvuuvIgL2BSM1663');
    expect(p.call?.index).toBe(11);
    expect(p.output?.index).toBe(12);
    expect(p.extras).toEqual([]);
  });

  it('P2 夹具 04：7 对全部配上，且顺序按首次出现', () => {
    const pairs = buildPairs(fixture('04-multi-turn.jsonl'));
    expect(pairs.size).toBe(7);
    expect([...pairs.keys()]).toEqual([
      'call_lf_0001',
      'call_lf_0002',
      'call_lf_0003',
      'call_lf_0004',
      'call_lf_0005',
      'call_lf_0006',
      'call_lf_0007',
    ]);
    // 每一对两侧都在，且 output 一定排在 call 后面
    for (const p of pairs.values()) {
      expect(p.call).toBeDefined();
      expect(p.output).toBeDefined();
      expect(p.output!.index).toBeGreaterThan(p.call!.index);
    }
  });

  it('P3 两条工具路径都认（function_call 与 custom_tool_call）', () => {
    const pairs = buildPairs(fixture('04-multi-turn.jsonl'));
    const types = [...pairs.values()].map((p) => p.call?.payloadType);
    expect(new Set(types)).toEqual(new Set(['function_call', 'custom_tool_call']));
  });

  it('P4 counterpart 双向可达：调用 ⇄ 结果', () => {
    const es = fixture('01-apply-patch-rejected.jsonl');
    const pairs = buildPairs(es);
    expect(counterpart(pairs, es[11])?.index).toBe(12);
    expect(counterpart(pairs, es[12])?.index).toBe(11);
  });

  it('P5 非工具条目没有对家（哪怕它带 call_id）', () => {
    const es = fixture('01-apply-patch-rejected.jsonl');
    // 索引 0 是 session_meta
    expect(counterpart(buildPairs(es), es[0])).toBeUndefined();
    expect(hasCounterpart(buildPairs(es), es[0])).toBe(false);
  });

  // ── ★ 三种「配不上」——rollout 的常态，不是坏数据 ──────────────
  describe('P6 配不上时返回 undefined，UI 据此把按钮藏起来', () => {
    it('只有调用没有结果（被中断 / 正在跟随）', () => {
      const es = synth([call('c1')]);
      const pairs = buildPairs(es);
      expect(pairs.get('c1')?.output).toBeUndefined();
      expect(counterpart(pairs, es[0])).toBeUndefined();
      expect(hasCounterpart(pairs, es[0])).toBe(false);
    });

    it('只有结果没有调用（文件从中间截断）', () => {
      const es = synth([output('c1')]);
      const pairs = buildPairs(es);
      expect(pairs.get('c1')?.call).toBeUndefined();
      expect(hasCounterpart(pairs, es[0])).toBe(false);
    });

    it('压根没有 call_id 的工具条目不进配对表', () => {
      const es = synth([
        { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{}' } },
      ]);
      expect(es[0].kind).toBe('tool_call');
      expect(es[0].callId).toBeUndefined();
      expect(buildPairs(es).size).toBe(0);
    });
  });

  it('P7 同一个 call_id 重复出现：取第一条，其余进 extras 而不是丢弃', () => {
    const es = synth([call('c1', 'shell'), call('c1', 'exec_command'), output('c1'), output('c1')]);
    const p = buildPairs(es).get('c1')!;
    expect(p.call?.index).toBe(0);
    expect(p.output?.index).toBe(2);
    // ★ 多余的两条必须留着——「绝不丢弃」是 §3.4 的原则，重复也不例外
    expect(p.extras.map((e) => e.index)).toEqual([1, 3]);
  });

  it('P8 非工具条目就算蹭到了同一个 call_id，也没有对家', () => {
    // 防御分支：配对表里有这个 call_id，但这条既不是调用也不是结果。
    // 真实数据里罕见，但「配对表命中」不等于「这条能跳转」，不能想当然。
    const es = synth([
      call('c1', 'shell'),
      output('c1'),
      { type: 'response_item', payload: { type: 'reasoning', content: 'x', call_id: 'c1' } },
    ]);
    const pairs = buildPairs(es);
    expect(es[2].callId).toBe('c1');
    expect(es[2].kind).toBe('reasoning');
    expect(pairs.has('c1')).toBe(true);
    expect(counterpart(pairs, es[2])).toBeUndefined();
    expect(hasCounterpart(pairs, es[2])).toBe(false);
  });

  it('P9 空输入不崩', () => {
    expect(buildPairs([]).size).toBe(0);
  });
});
