/**
 * SPEC §14.2 A/C/D 三组（9 + 14 + 7 = 30 条）的归一化验收。
 * B 组（10 条）在 redact.test.ts。合计 40 条。
 *
 * 期望值是从 test/fixtures/ 实测算出来的确切数字。
 * **实现与期望值对不上，是实现错了，不要改期望值。**
 * 尤其：C2 与 D2 的 assistant 计数是 4 与 2，这是真实差异，不是笔误。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { kindToGroup } from './groups';
import { PARSE_ERROR, classify, parseLine, summarize, toEntries, toEntry } from './rollout';
import type { DisplayGroup, Entry, EntryKind, RolloutRecord } from './types';

function readFixtureLines(name: string): string[] {
  const path = fileURLToPath(new URL(`../../test/fixtures/${name}`, import.meta.url));
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  // 文件以换行结尾会多出一个空元素，那不是「一行」
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function countKinds(entries: Entry[]): Partial<Record<EntryKind, number>> {
  const out: Partial<Record<EntryKind, number>> = {};
  for (const e of entries) out[e.kind] = (out[e.kind] ?? 0) + 1;
  return out;
}

function countGroups(entries: Entry[]): Partial<Record<DisplayGroup, number>> {
  const out: Partial<Record<DisplayGroup, number>> = {};
  for (const e of entries) {
    const g = kindToGroup(e.kind);
    out[g] = (out[g] ?? 0) + 1;
  }
  return out;
}

const EDGE_LINES = readFixtureLines('03-edge-cases.jsonl');
const EDGE = toEntries(EDGE_LINES);

const F01_LINES = readFixtureLines('01-apply-patch-rejected.jsonl');
const F01 = toEntries(F01_LINES);

const F02_LINES = readFixtureLines('02-exec-command.jsonl');
const F02 = toEntries(F02_LINES);

// ─────────────────────────────────────────────────────────────
// A. 解析健壮性 —— 03-edge-cases.jsonl
// ─────────────────────────────────────────────────────────────

describe('A. 解析健壮性 —— 03-edge-cases.jsonl', () => {
  it('A1 · 文件总行数 = 14', () => {
    expect(EDGE_LINES).toHaveLength(14);
  });

  it('A2 · 空行被过滤，不产生条目（恰好过滤 1 行）', () => {
    const blank = EDGE_LINES.filter((l) => l.trim() === '');
    expect(blank).toHaveLength(1);
    expect(EDGE).toHaveLength(EDGE_LINES.length - blank.length);
  });

  it('A3 · 产生的条目总数 = 13', () => {
    expect(EDGE).toHaveLength(13);
  });

  it('A4 · 坏行降级为 _parse_error，不抛异常、不中断（恰好 1 条，kind=error）', () => {
    const bad = EDGE.filter((e) => e.payloadType === PARSE_ERROR);
    expect(bad).toHaveLength(1);
    expect(bad[0].kind).toBe('error');
    expect(bad[0].payloadType).toBe('_parse_error');
    // 原文保留在 preview 里
    expect(bad[0].preview).toContain('未闭合');
  });

  it('A5 · 坏行之后的记录照常解析（第 8 行之后的条目数 = 6）', () => {
    const badIndex = EDGE.findIndex((e) => e.payloadType === PARSE_ERROR);
    expect(badIndex).toBe(6); // 第 7 行是坏行，第 8 行是空行
    expect(EDGE.length - (badIndex + 1)).toBe(6);
  });

  it('A6 · 未知 payload.type 不丢弃：kind=other 且 payloadType 原样保留', () => {
    const e = EDGE.find((x) => x.payloadType === 'some_future_item_type_v9');
    expect(e).toBeDefined();
    expect(e?.kind).toBe('other');
    expect(e?.topType).toBe('response_item');
  });

  it('A7 · 未知顶层 type 不丢弃：kind=other', () => {
    const e = EDGE.find((x) => x.topType === 'brand_new_top_level_type');
    expect(e).toBeDefined();
    expect(e?.kind).toBe('other');
  });

  it('A8 · payload 为空对象不崩，title 有兜底值', () => {
    const e = EDGE[8];
    expect(e.topType).toBe('event_msg');
    expect(e.payloadType).toBe('');
    expect(e.title.length).toBeGreaterThan(0);
    expect(e.kind).toBe('other');
  });

  it('A9 · 缺 timestamp 不崩，timestamp === 空字符串', () => {
    const e = EDGE[8];
    expect(e.timestamp).toBe('');
    expect(typeof e.timestamp).toBe('string');
  });
});

// ─────────────────────────────────────────────────────────────
// C. 分类与摘要 —— 01-apply-patch-rejected.jsonl（custom_tool_call 路径）
// ─────────────────────────────────────────────────────────────

describe('C. 分类与摘要 —— 01-apply-patch-rejected.jsonl', () => {
  const s = summarize(F01);

  it('C1 · 条目总数 = 19', () => {
    expect(F01).toHaveLength(19);
  });

  it('C2 · kind 计数', () => {
    expect(countKinds(F01)).toEqual({
      session: 1,
      context: 1,
      state: 1,
      user: 4,
      assistant: 4, // 与 02 的 2 不同，这是真实差异
      reasoning: 2,
      tool_call: 1,
      tool_out: 1,
      usage: 2,
      lifecycle: 2,
    });
  });

  it('C3 · summary.model = deepseek-v4-flash', () => {
    expect(s.model).toBe('deepseek-v4-flash');
  });

  it('C4 · summary.effort = high', () => {
    expect(s.effort).toBe('high');
  });

  it('C5 · summary.approval = never', () => {
    expect(s.approval).toBe('never');
  });

  it('C6 · summary.sandbox = read-only（读 sandbox_policy.type）', () => {
    expect(s.sandbox).toBe('read-only');
  });

  it('C7 · summary.provider = custom', () => {
    expect(s.provider).toBe('custom');
  });

  it('C8 · summary.cwd = /Users/dev/workspace/codex/codex-rs', () => {
    expect(s.cwd).toBe('/Users/dev/workspace/codex/codex-rs');
  });

  it('C9 · summary.durationMs = 14058', () => {
    expect(s.durationMs).toBe(14058);
  });

  it('C10 · summary.ttftMs = 3936', () => {
    expect(s.ttftMs).toBe(3936);
  });

  it('C11 · summary.inputTokens / outputTokens = 34188 / 263（取最后一条 token_count）', () => {
    expect(s.inputTokens).toBe(34188);
    expect(s.outputTokens).toBe(263);
  });

  it('C12 · 索引 11 是工具调用 apply_patch', () => {
    const e = F01[11];
    expect(e.kind).toBe('tool_call');
    expect(e.title).toBe('→ apply_patch');
    expect(e.callId).toBe('call_00_VGd9DAeHsvuuvIgL2BSM1663');
    // custom_tool_call 的参数在 input，是纯文本 patch
    expect(e.payloadType).toBe('custom_tool_call');
    expect(e.preview.startsWith('*** Begin Patch')).toBe(true);
  });

  it('C13 · 索引 12 是工具结果，preview 以拒绝信息开头', () => {
    const e = F01[12];
    expect(e.kind).toBe('tool_out');
    expect(
      e.preview.startsWith('patch rejected: writing is blocked by read-only sandbox'),
    ).toBe(true);
  });

  it('C14 · 索引 11 与 12 的 callId 相同（可配对）', () => {
    expect(F01[11].callId).toBe(F01[12].callId);
    expect(F01[11].callId).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────
// D. 另一条工具路径 —— 02-exec-command.jsonl（function_call 路径）
// ─────────────────────────────────────────────────────────────

describe('D. 另一条工具路径 —— 02-exec-command.jsonl', () => {
  const s = summarize(F02);

  it('D1 · 条目总数 = 17', () => {
    expect(F02).toHaveLength(17);
  });

  it('D2 · kind 计数（assistant = 2，与 01 的 4 不同，是真实差异）', () => {
    expect(countKinds(F02)).toEqual({
      session: 1,
      context: 1,
      state: 1,
      user: 4,
      assistant: 2,
      reasoning: 2,
      tool_call: 1,
      tool_out: 1,
      usage: 2,
      lifecycle: 2,
    });
  });

  it('D3 · summary.durationMs / ttftMs = 13729 / 4241', () => {
    expect(s.durationMs).toBe(13729);
    expect(s.ttftMs).toBe(4241);
  });

  it('D4 · summary.inputTokens / outputTokens = 37032 / 393', () => {
    expect(s.inputTokens).toBe(37032);
    expect(s.outputTokens).toBe(393);
  });

  it('D5 · 索引 9 是工具调用 exec_command', () => {
    const e = F02[9];
    expect(e.kind).toBe('tool_call');
    expect(e.title).toBe('→ exec_command');
    expect(e.callId).toBe('call_00_ZcxhkqWcZL0PNkjMBG5H1809');
  });

  it('D6 · function_call.arguments 二次解析后展示为格式化对象，而非转义字符串', () => {
    const e = F02[9];
    expect(e.payloadType).toBe('function_call');
    expect(e.preview).toBe(JSON.stringify({ cmd: 'ls -la' }, null, 2));
    expect(e.preview).toContain('\n'); // 已格式化
    expect(e.preview).not.toContain('\\"'); // 不是转义后的 JSON 字符串
  });

  it('D7 · 索引 10 工具结果，preview 以 "Chunk ID:" 开头', () => {
    const e = F02[10];
    expect(e.kind).toBe('tool_out');
    expect(e.preview.startsWith('Chunk ID:')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// 补充：显示层分组（§14.4 F14 由 C2 换算而来，属于纯函数可测范围）
// ─────────────────────────────────────────────────────────────

describe('§6.3 显示层分组', () => {
  it('01 号夹具的六组计数 = 输入6 · 思考2 · 行动2 · 输出4 · 元信息5（合计 19）', () => {
    expect(countGroups(F01)).toEqual({ input: 6, think: 2, act: 2, output: 4, meta: 5 });
  });

  it('02 号夹具的六组计数 = 输入6 · 思考2 · 行动2 · 输出2 · 元信息5（合计 17）', () => {
    expect(countGroups(F02)).toEqual({ input: 6, think: 2, act: 2, output: 2, meta: 5 });
  });

  it('03 号夹具的坏行落在「异常」组', () => {
    expect(countGroups(EDGE).error).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────
// 补充：纯函数边界（§3.4「字段全部可选」）
// ─────────────────────────────────────────────────────────────

describe('parseLine · 宽松解析', () => {
  it('合法行还原为统一信封', () => {
    const rec = parseLine('{"timestamp":"t","type":"event_msg","payload":{"type":"x"}}', 1);
    expect(rec.type).toBe('event_msg');
    expect(rec.timestamp).toBe('t');
    expect(rec.payload?.type).toBe('x');
  });

  it('坏行降级为 _parse_error 并保留原文与行号', () => {
    const rec = parseLine('{oops', 7);
    expect(rec.type).toBe(PARSE_ERROR);
    expect(rec.payload?.type).toBe(PARSE_ERROR);
    expect(rec.payload?.lineno).toBe(7);
    expect(rec.payload?.text).toBe('{oops');
  });

  it('JSON 合法但不是对象（数组 / 标量）也降级为 _parse_error', () => {
    expect(parseLine('[1,2]', 1).type).toBe(PARSE_ERROR);
    expect(parseLine('42', 2).type).toBe(PARSE_ERROR);
    expect(parseLine('null', 3).type).toBe(PARSE_ERROR);
  });

  it('type / timestamp / payload 类型不对时有兜底', () => {
    const rec = parseLine('{"type":123,"timestamp":456,"payload":"not-an-object","extra":1}', 1);
    expect(rec.type).toBe('');
    expect(rec.timestamp).toBeUndefined();
    expect(rec.payload).toBeUndefined();
    // 顶层的额外字段不丢
    expect((rec as unknown as Record<string, unknown>).extra).toBe(1);
  });
});

describe('classify · 各分支兜底', () => {
  const c = (rec: RolloutRecord) => classify(rec);

  it('session_meta / turn_context / world_state 各归其位', () => {
    expect(c({ type: 'session_meta', payload: {} }).kind).toBe('session');
    expect(c({ type: 'turn_context', payload: {} }).kind).toBe('context');
    expect(c({ type: 'world_state', payload: {} }).kind).toBe('state');
  });

  it('message 的 role：user / developer / system → user，assistant → assistant', () => {
    const mk = (role: string) =>
      c({ type: 'response_item', payload: { type: 'message', role, content: [{ text: 'x' }] } });
    expect(mk('user').kind).toBe('user');
    expect(mk('developer').kind).toBe('user');
    expect(mk('system').kind).toBe('user');
    expect(mk('assistant').kind).toBe('assistant');
    expect(mk('assistant').title).toBe('模型');
    expect(mk('developer').title).toBe('开发者');
    expect(mk('system').title).toBe('系统');
    expect(mk('').title).toBe('用户');
  });

  it('event_msg 的生命周期 / 用量 / 错误分支', () => {
    expect(c({ type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } }).kind).toBe(
      'lifecycle',
    );
    const done = c({
      type: 'event_msg',
      payload: { type: 'task_complete', duration_ms: 12, time_to_first_token_ms: 3 },
    });
    expect(done.kind).toBe('lifecycle');
    expect(done.preview).toContain('12ms');
    const usage = c({
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 5, output_tokens: 6 } } },
    });
    expect(usage.kind).toBe('usage');
    expect(usage.preview).toBe('输入 5 · 输出 6');
    expect(c({ type: 'event_msg', payload: { type: 'error', message: 'boom' } }).kind).toBe('error');
    expect(c({ type: 'event_msg', payload: { type: 'stream_error' } }).kind).toBe('error');
  });

  it('reasoning 的 content 为空时退回 summary', () => {
    const r = c({
      type: 'response_item',
      payload: { type: 'reasoning', content: [], summary: [{ text: '想了想' }] },
    });
    expect(r.kind).toBe('reasoning');
    expect(r.preview).toBe('想了想');
  });

  it('工具调用缺 name 时 title 有兜底；arguments 不是 JSON 时按纯文本展示', () => {
    const fc = c({ type: 'response_item', payload: { type: 'function_call', arguments: 'not json' } });
    expect(fc.title).toBe('→ 工具');
    expect(fc.preview).toBe('not json');
    const ctc = c({ type: 'response_item', payload: { type: 'custom_tool_call' } });
    expect(ctc.title).toBe('→ 工具');
    // arguments 已经是对象时直接格式化
    const objArgs = c({
      type: 'response_item',
      payload: { type: 'function_call', name: 'n', arguments: { a: 1 } },
    });
    expect(objArgs.preview).toBe('{\n  "a": 1\n}');
    expect(
      c({ type: 'response_item', payload: { type: 'function_call', name: 'n' } }).preview,
    ).toBe('');
  });

  it('工具结果的 output 可以是字符串 / 对象 / 数组', () => {
    const out = (v: unknown) =>
      c({ type: 'response_item', payload: { type: 'function_call_output', output: v } }).preview;
    expect(out('plain')).toBe('plain');
    expect(out({ output: 'wrapped' })).toBe('wrapped');
    expect(out({ text: 'texted' })).toBe('texted');
    expect(out({ content: [{ text: 'a' }, 'b'] })).toBe('a\nb');
    expect(out({ weird: 1 })).toBe('{\n  "weird": 1\n}');
    expect(out(['x', { text: 'y' }])).toBe('x\ny');
    expect(out(['x', null, 42, { text: 'y' }])).toBe('x\ny'); // 数组里的杂质被跳过
    expect(out({ content: 'plain-content' })).toBe('plain-content');
    expect(out(123)).toBe('');
  });

  it('turnId 从 payload.turn_id 或 metadata passthrough 提取', () => {
    expect(c({ type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } }).turnId).toBe('t1');
    expect(
      c({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          internal_chat_message_metadata_passthrough: { turn_id: 't2' },
        },
      }).turnId,
    ).toBe('t2');
  });

  it('空记录不崩', () => {
    expect(c({ type: '' }).kind).toBe('other');
    expect(c({ type: '' }).title).toBe('未知');
  });
});

describe('toEntry / toEntries', () => {
  it('toEntry 的 index 原样带出，raw 是脱敏后的记录', () => {
    const e = toEntry(parseLine('{"type":"event_msg","payload":{"type":"user_message","message":"hi"}}', 1), 7);
    expect(e.index).toBe(7);
    expect(e.rawPretty).toBe(JSON.stringify(e.raw, null, 2));
    expect(e.preview).toBe('hi');
  });

  it('toEntries 自己过滤空行与纯空白行，index 连续', () => {
    const entries = toEntries(['', '   ', '{"type":"world_state","payload":{}}', '\t']);
    expect(entries).toHaveLength(1);
    expect(entries[0].index).toBe(0);
    expect(toEntries([]).length).toBe(0);
  });
});

describe('summarize · 缺字段兜底', () => {
  it('空数组返回全兜底值，不崩', () => {
    expect(summarize([])).toEqual({
      sessionId: '',
      cwd: '',
      cliVersion: '',
      provider: '',
      model: '',
      effort: '',
      approval: '',
      sandbox: '',
    });
  });

  it('sessionId / cliVersion 从 session_meta 取', () => {
    const s = summarize(F01);
    expect(s.sessionId).toBe('019fcac2-c504-7f50-b148-d2d6767c0e06');
    expect(s.cliVersion).toBe('0.0.0');
  });

  it('没有 session_meta 时 cwd 退回 turn_context.cwd', () => {
    const s = summarize(
      toEntries(['{"type":"turn_context","payload":{"cwd":"/tmp/x","model":"m"}}']),
    );
    expect(s.cwd).toBe('/tmp/x');
    expect(s.model).toBe('m');
    expect(s.sandbox).toBe('');
  });

  it('token_count 取最后一条', () => {
    const s = summarize(
      toEntries([
        '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1,"output_tokens":2}}}}',
        '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":9,"output_tokens":8}}}}',
      ]),
    );
    expect(s.inputTokens).toBe(9);
    expect(s.outputTokens).toBe(8);
  });

  it('03 号夹具（手工构造）也能出摘要', () => {
    const s = summarize(EDGE);
    expect(s.model).toBe('test-model');
    expect(s.sandbox).toBe('read-only');
    expect(s.durationMs).toBe(9000);
    expect(s.ttftMs).toBe(800);
    expect(s.inputTokens).toBe(100);
    expect(s.outputTokens).toBe(20);
  });
});
