/**
 * 显示层纯函数。跑 node 环境，不需要 DOM。
 */
import { describe, expect, it } from 'vitest';
import type { Entry } from '../shared/types';
import { LOCALES, ref, translate } from '../shared/i18n';
import {
  KIND_KEY,
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
    // 归一化层现在出的是 MsgRef，不是拼好的字符串（SPEC §15.1）
    title: ref('entry.toolCall', { tool: 'apply_patch' }),
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
  it('12 个 kind 都有标签，两种语言下都不缺、都不空', () => {
    expect(Object.keys(KIND_KEY)).toHaveLength(12);
    for (const locale of LOCALES) {
      for (const key of Object.values(KIND_KEY)) {
        expect(translate(locale, key).trim()).not.toBe('');
      }
    }
  });

  /**
   * ★ 分类名这一列是**固定宽**的（`.row-kind` 的 `--kind-col`），因为「所有行的
   * 标题从同一个 x 起排」是 F2 的前提之一。所以标签长度是有硬上限的，
   * 而上限**逐语言不同**——中文两个汉字 ≈ 4ch，列宽 5ch；英文列宽 8ch。
   *
   * 这条断言和 global.css 里的 `--kind-col` 是一对，改一边就得改另一边。
   */
  it('标签长度不超出各自语言的列宽预算', () => {
    const BUDGET: Record<string, number> = { 'zh-CN': 2, en: 8 };
    for (const locale of LOCALES) {
      for (const key of Object.values(KIND_KEY)) {
        expect(translate(locale, key).length).toBeLessThanOrEqual(BUDGET[locale]);
      }
    }
  });

  it('中文一律两个汉字——列宽 5ch 这个数字就是从这来的', () => {
    for (const key of Object.values(KIND_KEY)) {
      expect(translate('zh-CN', key)).toHaveLength(2);
    }
  });

  it('未知 kind 降级为「其它」，不崩（§3.4 宽松解析的显示侧）', () => {
    expect(kindLabel('zh-CN', 'some_future_kind')).toBe('其它');
    expect(kindLabel('en', 'some_future_kind')).toBe('Other');
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
    expect(matchesQuery('zh-CN', entry(), '')).toBe(true);
    expect(matchesQuery('zh-CN', entry(), '   ')).toBe(true);
  });

  it('大小写不敏感，标题可命中', () => {
    expect(matchesQuery('zh-CN', entry(), 'APPLY_patch')).toBe(true);
  });

  it('正文可命中', () => {
    expect(matchesQuery('zh-CN', entry(), 'begin patch')).toBe(true);
  });

  it('★ 原始 JSON 也在搜索范围内——F17/B10 要求搜脱敏后的尾 4 位能命中，', () => {
    const e = entry({ preview: '无关正文', rawPretty: '{ "OPENAI_API_KEY": "sk-••••ab12" }' });
    expect(matchesQuery('zh-CN', e, 'ab12')).toBe(true);
  });

  it('不命中就是不命中', () => {
    expect(matchesQuery('zh-CN', entry(), 'zzz-not-here')).toBe(false);
  });

  /**
   * ★ 搜索必须搜**用户眼前那个语言的文案**（SPEC §15.1）。
   *
   * 标题现在是 MsgRef，`matchesQuery` 得先翻译再比对。搜「模型」在中文界面下
   * 该命中的那条，在英文界面下应该搜「Model」才命中——否则「所见即可搜」
   * 这条就不成立了，而它正是 F7 的全部意义。
   */
  it('标题按当前语言参与匹配，不是按某个固定语言', () => {
    const e = entry({ kind: 'assistant', title: ref('entry.assistant'), preview: '', rawPretty: '{}' });
    expect(matchesQuery('zh-CN', e, '模型')).toBe(true);
    expect(matchesQuery('zh-CN', e, 'Model')).toBe(false);
    expect(matchesQuery('en', e, 'Model')).toBe(true);
    expect(matchesQuery('en', e, '模型')).toBe(false);
  });
});

describe('basename', () => {
  it('渲染进程没有 path 模块，自己切', () => {
    expect(basename('/a/b/c.jsonl')).toBe('c.jsonl');
    expect(basename('c.jsonl')).toBe('c.jsonl');
    expect(basename('C:\\x\\y.jsonl')).toBe('y.jsonl');
  });
});
