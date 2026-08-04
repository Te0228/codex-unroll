/**
 * 显示层纯函数。跑 node 环境，不需要 DOM。
 */
import { describe, expect, it } from 'vitest';
import type { Entry } from '../shared/types';
import {
  KIND_LABEL,
  ROW_PREVIEW_MAX,
  basename,
  formatBytes,
  formatClock,
  formatDuration,
  kindLabel,
  matchesQuery,
  oneLine,
  rowPreview,
} from './format';

function entry(over: Partial<Entry> = {}): Entry {
  return {
    index: 0,
    timestamp: '2026-08-04T03:13:16.000Z',
    topType: 'response_item',
    payloadType: 'custom_tool_call',
    kind: 'tool_call',
    title: '→ apply_patch',
    preview: '*** Begin Patch',
    raw: {},
    rawPretty: '{\n  "type": "custom_tool_call"\n}',
    ...over,
  };
}

describe('formatClock', () => {
  it('缺 timestamp 时给等宽占位，列宽不抖', () => {
    expect(formatClock('')).toBe('--:--:--');
    expect(formatClock('not-a-date')).toBe('--:--:--');
  });

  it('输出 HH:MM:SS 共 8 字符（§6.2 的 8ch 时间列）', () => {
    expect(formatClock('2026-08-04T03:13:16.000Z')).toHaveLength(8);
    expect(formatClock('2026-08-04T03:13:16.000Z')).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});

describe('formatBytes / formatDuration', () => {
  it('体积', () => {
    expect(formatBytes(512)).toBe('512B');
    expect(formatBytes(104 * 1024)).toBe('104K');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0M');
  });

  it('时长', () => {
    expect(formatDuration(undefined)).toBe('—');
    expect(formatDuration(936)).toBe('936ms');
    expect(formatDuration(14058)).toBe('14.06s');
  });
});

describe('kindLabel', () => {
  it('12 个 kind 各有短标签，且一律两个汉字——列宽稳定是 F2 等高的前提', () => {
    const labels = Object.values(KIND_LABEL);
    expect(labels).toHaveLength(12);
    for (const l of labels) expect(l).toHaveLength(2);
  });

  it('未知 kind 降级为「其它」，不崩（§3.4 宽松解析的显示侧）', () => {
    expect(kindLabel('some_future_kind')).toBe('其它');
  });
});

describe('oneLine / rowPreview（F2 / F3 的前置条件）', () => {
  it('换行全部折成空格——否则 nowrap 也挡不住多行', () => {
    expect(oneLine('a\nb\r\n\tc   d')).toBe('a b c d');
  });

  it('11 459 字符的条目在 DOM 里也只留一小截，视觉截断交给 CSS 省略号', () => {
    const huge = 'x'.repeat(11459);
    const row = rowPreview(huge);
    expect(row.length).toBeLessThanOrEqual(ROW_PREVIEW_MAX + 1);
    expect(row.includes('\n')).toBe(false);
  });
});

describe('matchesQuery（F7：标题 + 内容 + 原始 JSON）', () => {
  it('空查询匹配一切', () => {
    expect(matchesQuery(entry(), '')).toBe(true);
    expect(matchesQuery(entry(), '   ')).toBe(true);
  });

  it('大小写不敏感，标题可命中', () => {
    expect(matchesQuery(entry(), 'APPLY_patch')).toBe(true);
  });

  it('正文可命中', () => {
    expect(matchesQuery(entry(), 'begin patch')).toBe(true);
  });

  it('★ 原始 JSON 也在搜索范围内——F17/B10 要求搜脱敏后的尾 4 位能命中，', () => {
    const e = entry({ preview: '无关正文', rawPretty: '{ "OPENAI_API_KEY": "sk-••••ab12" }' });
    expect(matchesQuery(e, 'ab12')).toBe(true);
  });

  it('不命中就是不命中', () => {
    expect(matchesQuery(entry(), 'zzz-not-here')).toBe(false);
  });
});

describe('basename', () => {
  it('渲染进程没有 path 模块，自己切', () => {
    expect(basename('/a/b/c.jsonl')).toBe('c.jsonl');
    expect(basename('c.jsonl')).toBe('c.jsonl');
    expect(basename('C:\\x\\y.jsonl')).toBe('y.jsonl');
  });
});
