/**
 * SPEC §14.9：Session ▸ Turn ▸ Step 切分的验收（S 组）。
 *
 * 期望值全部是从 test/fixtures/ 实测算出来的确切数字，
 * 和 §14.2 对得上（S5 的 14058/3936 就是 C9/C10，S7 的 34188/263 就是 C11）。
 * **实现与期望值对不上，是实现错了，不要改期望值。**
 *
 * ★ S9 是这一组的地基：切分是启发式，但「一条不丢」不是启发式。
 *   flattenGraph(buildGraph(es)) 必须恒等于 es——同样的对象、同样的顺序。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { toEntries } from './rollout';
import { buildGraph, countSteps, flattenGraph, isUserInput } from './steps';
import type { Entry } from './types';

const FIXTURES = [
  '01-apply-patch-rejected.jsonl',
  '02-exec-command.jsonl',
  '03-edge-cases.jsonl',
] as const;

function readFixtureLines(name: string): string[] {
  const path = fileURLToPath(new URL(`../../test/fixtures/${name}`, import.meta.url));
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

const fixture = (name: string): Entry[] => toEntries(readFixtureLines(name));

/** 手搓一份 JSONL 用来测退化路径。夹具是验收基线，不为边界情况去改它。 */
function synth(records: unknown[]): Entry[] {
  return toEntries(records.map((r) => JSON.stringify(r)));
}

const started = (turnId: string) => ({
  timestamp: '2026-08-10T00:00:00.000Z',
  type: 'event_msg',
  payload: { type: 'task_started', turn_id: turnId },
});
const context = (turnId: string, model = 'm') => ({
  type: 'turn_context',
  payload: { turn_id: turnId, model, sandbox_policy: { type: 'read-only' } },
});
const reasoning = (text: string) => ({
  type: 'response_item',
  payload: { type: 'reasoning', content: text },
});
const answer = (text: string) => ({
  type: 'response_item',
  payload: { type: 'message', role: 'assistant', content: text },
});
const toolCall = (name: string) => ({
  type: 'response_item',
  payload: { type: 'function_call', name, arguments: '{}' },
});
const usage = (input: number, output: number) => ({
  type: 'event_msg',
  payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: output } } },
});
const complete = (turnId: string) => ({
  type: 'event_msg',
  payload: { type: 'task_complete', turn_id: turnId, duration_ms: 1000 },
});

const indices = (es: Entry[]) => es.map((e) => e.index);

// ─────────────────────────────────────────────────────────────
describe('§14.9 S 组：Turn / Step 切分', () => {
  // ── 夹具 01：两条工具路径中的 custom_tool_call ─────────────────
  describe('夹具 01（apply_patch 被拒绝）', () => {
    const g = buildGraph(fixture(FIXTURES[0]));

    it('S1 1 个 Turn、2 个 Step', () => {
      expect(g.turns).toHaveLength(1);
      expect(g.turns[0].steps).toHaveLength(2);
      expect(countSteps(g)).toBe(2);
    });

    it('S2 session_meta 落在会话前言，不属于任何 Turn', () => {
      expect(indices(g.preamble)).toEqual([0]);
      expect(g.preamble[0].topType).toBe('session_meta');
    });

    it('S3 turnId 取自 task_started / turn_context', () => {
      expect(g.turns[0].turnId).toBe('019fcac2-c54b-7223-bc43-2b943b5820a4');
    });

    it('S4 冻结配置来自 turn_context（sandbox 读 .type）', () => {
      const t = g.turns[0];
      expect(t.model).toBe('deepseek-v4-flash');
      expect(t.effort).toBe('high');
      expect(t.approval).toBe('never');
      expect(t.sandbox).toBe('read-only');
    });

    it('S5 时长/首字来自 task_complete，与 §14.2 C9/C10 一致', () => {
      expect(g.turns[0].durationMs).toBe(14058);
      expect(g.turns[0].ttftMs).toBe(3936);
      expect(g.turns[0].status).toBe('complete');
    });

    it('S6 Turn 前言到第一条模型产出为止（7 条）', () => {
      expect(indices(g.turns[0].preamble)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });

    it('S7 Step 1 以工具调用结束 → act，循环继续', () => {
      const s = g.turns[0].steps[0];
      expect(indices(s.entries)).toEqual([8, 9, 10, 11, 12]);
      expect(s.usage?.index).toBe(13);
      expect(s.outcome).toBe('act');
      expect(s.tools).toEqual(['→ apply_patch']);
      expect([s.inputTokens, s.outputTokens]).toEqual([16986, 187]);
      expect(s.hasError).toBe(false);
    });

    it('S8 Step 2 只回消息 → answer，出环；用量即 §14.2 C11 的会话合计', () => {
      const s = g.turns[0].steps[1];
      expect(indices(s.entries)).toEqual([14, 15, 16]);
      expect(s.usage?.index).toBe(17);
      expect(s.outcome).toBe('answer');
      expect(s.tools).toEqual([]);
      expect([s.inputTokens, s.outputTokens]).toEqual([34188, 263]);
    });

    it('S9 task_complete 挂在 Turn 上，不进任何 Step', () => {
      expect(g.turns[0].end?.index).toBe(18);
      expect(g.turns[0].end?.payloadType).toBe('task_complete');
    });
  });

  // ── 夹具 02：另一条工具路径 function_call ──────────────────────
  it('S10 夹具 02 走 function_call 路径，结构同样是 1 Turn / 2 Step', () => {
    const g = buildGraph(fixture(FIXTURES[1]));
    expect(g.turns).toHaveLength(1);
    expect(g.turns[0].steps).toHaveLength(2);
    expect(g.turns[0].steps[0].tools).toEqual(['→ exec_command']);
    expect(g.turns[0].steps[0].outcome).toBe('act');
    expect(g.turns[0].steps[1].outcome).toBe('answer');
  });

  // ── 夹具 03：没有 task_started，只能靠 turn_context 起 Turn ────
  it('S11 夹具 03 无 task_started，turn_context 也能起 Turn', () => {
    const g = buildGraph(fixture(FIXTURES[2]));
    expect(g.turns).toHaveLength(1);
    expect(g.turns[0].turnId).toBe('turn-1');
    expect(g.turns[0].steps).toHaveLength(1);
    expect(g.turns[0].steps[0].tools).toEqual(['→ shell']);
  });

  it('S12 未知类型/坏行落在 Turn 前言，照常保留不丢弃（§3.4）', () => {
    const pre = buildGraph(fixture(FIXTURES[2])).turns[0].preamble;
    expect(pre.map((e) => e.topType)).toContain('brand_new_top_level_type');
    expect(pre.map((e) => e.payloadType)).toContain('_parse_error');
  });

  // ── ★ 地基：一条都不能丢 ──────────────────────────────────────
  describe('S13 flatten 恒等：切分是启发式，不丢条目不是', () => {
    for (const name of FIXTURES) {
      it(name, () => {
        const es = fixture(name);
        // toEqual 比不出「是不是同一个对象」，这里要的是引用相同
        expect(flattenGraph(buildGraph(es))).toEqual(es);
        expect(flattenGraph(buildGraph(es)).every((e, i) => e === es[i])).toBe(true);
      });
    }
  });
});

// ─────────────────────────────────────────────────────────────
describe('§14.9 S 组：退化路径', () => {
  it('S14 空输入 → 空图，不崩', () => {
    const g = buildGraph([]);
    expect(g.preamble).toEqual([]);
    expect(g.turns).toEqual([]);
    expect(countSteps(g)).toBe(0);
  });

  it('S15 全是无 Turn 标记的条目 → 全落会话前言', () => {
    const es = synth([reasoning('a'), toolCall('shell')]);
    const g = buildGraph(es);
    expect(g.turns).toEqual([]);
    expect(indices(g.preamble)).toEqual([0, 1]);
  });

  it('S16 一个 token_count 都没有 → 整个 Turn 退化成一个 open Step，内容一条不少', () => {
    const es = synth([started('t1'), context('t1'), reasoning('a'), toolCall('shell')]);
    const g = buildGraph(es);
    expect(g.turns[0].steps).toHaveLength(1);
    expect(g.turns[0].steps[0].outcome).toBe('open');
    expect(indices(g.turns[0].steps[0].entries)).toEqual([2, 3]);
    expect(flattenGraph(g)).toEqual(es);
  });

  it('S17 没等到 task_complete → Turn 状态 open（正在跟随/被中断）', () => {
    const es = synth([started('t1'), context('t1'), reasoning('a'), answer('done'), usage(1, 2)]);
    const g = buildGraph(es);
    expect(g.turns[0].status).toBe('open');
    expect(g.turns[0].end).toBeUndefined();
    // Turn 没收尾，但这个 Step 已经收尾了——两件事互相独立
    expect(g.turns[0].steps[0].outcome).toBe('answer');
  });

  it('S17b 只有推理、既没工具也没回答 → act，不能报「收工」', () => {
    const es = synth([started('t1'), reasoning('a'), usage(1, 2)]);
    expect(buildGraph(es).turns[0].steps[0].outcome).toBe('act');
  });

  it('S18 第二个 turn_context 起新 Turn，即便中间没有 task_started', () => {
    const es = synth([context('t1'), reasoning('a'), usage(1, 2), context('t2'), reasoning('b')]);
    const g = buildGraph(es);
    expect(g.turns).toHaveLength(2);
    expect(g.turns.map((t) => t.turnId)).toEqual(['t1', 't2']);
    expect(flattenGraph(g)).toEqual(es);
  });

  it('S19 turn_context 在 task_started 之后属于同一个 Turn，不再切一刀', () => {
    const es = synth([started('t1'), context('t1'), reasoning('a'), usage(1, 2), complete('t1')]);
    expect(buildGraph(es).turns).toHaveLength(1);
  });

  it('S20 同一个 task_started 换了 turn_id 的 turn_context → 切新 Turn', () => {
    const es = synth([started('t1'), context('t2'), reasoning('a')]);
    const g = buildGraph(es);
    expect(g.turns).toHaveLength(2);
    expect(flattenGraph(g)).toEqual(es);
  });

  it('S21 无正文的 token_count：还没有 Step 时并入前言，顺序不乱', () => {
    const es = synth([started('t1'), usage(1, 2), reasoning('a'), usage(3, 4), complete('t1')]);
    const g = buildGraph(es);
    expect(g.turns[0].steps).toHaveLength(1);
    expect(indices(g.turns[0].preamble)).toEqual([0, 1]);
    expect(flattenGraph(g)).toEqual(es);
  });

  it('S22 无正文的 token_count：已经有 Step 时生成退化 Step，顺序仍不乱', () => {
    const es = synth([started('t1'), reasoning('a'), usage(1, 2), usage(3, 4), complete('t1')]);
    const g = buildGraph(es);
    expect(g.turns[0].steps).toHaveLength(2);
    expect(g.turns[0].steps[1].entries).toEqual([]);
    // 既没工具也没回答 → 不能报「收工」
    expect(g.turns[0].steps[1].outcome).toBe('act');
    expect(flattenGraph(g)).toEqual(es);
  });

  it('S23 Step 内有坏行 → hasError', () => {
    const es = synth([started('t1'), reasoning('a')]);
    const withBad = toEntries([
      JSON.stringify(started('t1')),
      JSON.stringify(reasoning('a')),
      '{ 这行不是合法 JSON',
      JSON.stringify(usage(1, 2)),
    ]);
    expect(buildGraph(es).turns[0].steps[0].hasError).toBe(false);
    expect(buildGraph(withBad).turns[0].steps[0].hasError).toBe(true);
  });

  /**
   * isUserInput 决定 Turn 前言里哪一条常显。认错了的后果是
   * 「这一轮为什么开始」被折叠起来看不见——比多显一条严重得多。
   */
  describe('S25 isUserInput 认两种落盘形式', () => {
    const [ev, userMsg, devMsg, sysMsg, botMsg] = toEntries([
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'hi' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: 'hi' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'developer', content: 'x' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'system', content: 'x' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'x' } }),
    ]);

    it('event_msg/user_message 是', () => expect(isUserInput(ev)).toBe(true));
    it('response_item/message + role=user 也是', () => expect(isUserInput(userMsg)).toBe(true));

    it('developer / system 不是——它们和 role=user 同属 kind=user，不能用 kind 判', () => {
      expect(devMsg.kind).toBe('user');
      expect(sysMsg.kind).toBe('user');
      expect(isUserInput(devMsg)).toBe(false);
      expect(isUserInput(sysMsg)).toBe(false);
    });

    it('assistant 不是', () => expect(isUserInput(botMsg)).toBe(false));

    /**
     * ★ 这条钉住的是一个反直觉的实测事实：夹具 01 命中的是 **3 条不是 2 条**。
     *   索引 3 是 Codex 注入的 AGENTS.md，落盘也带 role=user——
     *   所以 role=user ≠ 人打的字，只有 event_msg/user_message 才是可靠信号。
     *   调用方据此优先只认事件那份（StepGraph 的 hasEventUser 分支）。
     */
    it('夹具 01 命中 3 条，其中索引 3 是 AGENTS.md 注入而非真人输入', () => {
      const pre = buildGraph(fixture(FIXTURES[0])).turns[0].preamble;
      expect(indices(pre.filter(isUserInput))).toEqual([3, 6, 7]);
      expect(pre[2].preview).toContain('AGENTS.md');
      // 事件那一份只有 1 条，这就是「优先只认它」能去重的原因
      expect(indices(pre.filter((e) => e.payloadType === 'user_message'))).toEqual([7]);
    });
  });

  it('S26 Turn 序号从 1 起且连续', () => {
    const es = synth([
      started('t1'),
      reasoning('a'),
      usage(1, 2),
      complete('t1'),
      started('t2'),
      reasoning('b'),
      usage(3, 4),
      complete('t2'),
    ]);
    const g = buildGraph(es);
    expect(g.turns.map((t) => t.no)).toEqual([1, 2]);
    expect(g.turns.flatMap((t) => t.steps.map((s) => s.no))).toEqual([1, 1]);
    expect(countSteps(g)).toBe(2);
  });
});
