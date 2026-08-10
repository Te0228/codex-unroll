/**
 * F20 · 对比度 / F21 · 不依赖颜色的可辨识性（§6.3）。
 *
 * 色值直接从 global.css 里抠出来算，不在测试里另抄一份——
 * 抄一份就等于给自己发了一张「改了 CSS 也不会红」的免罪符。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GROUPS, kindToGroup } from '../shared/groups';
import { LOCALES, translate } from '../shared/i18n';
import type { EntryKind } from '../shared/types';

const css = readFileSync(fileURLToPath(new URL('./styles/global.css', import.meta.url)), 'utf8');

function block(start: string): string {
  const i = css.indexOf(start);
  expect(i, `找不到 ${start}`).toBeGreaterThan(-1);
  return css.slice(i, css.indexOf('\n}\n', i));
}

function vars(scope: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of scope.matchAll(/(--[a-z-]+):\s*(#[0-9a-fA-F]{6})/g)) out[m[1]] = m[2];
  return out;
}

const light = vars(block(':root {'));
const dark = vars(block('@media (prefers-color-scheme: dark)'));

function relLum(hex: string): number {
  const ch = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

function contrast(a: string, b: string): number {
  const [l1, l2] = [relLum(a), relLum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/** 刻意弱化的两组（§6.3：思考「量大但通常不是要找的」、元信息「几乎不抢视线」）→ 3:1 档 */
const MUTED = new Set(['--g-think', '--g-meta']);

describe.each([
  ['浅色', light],
  ['深色', dark],
])('F20 · %s 主题对比度', (_name, theme) => {
  it('正文 ≥ 4.5:1', () => {
    expect(contrast(theme['--fg'], theme['--bg'])).toBeGreaterThanOrEqual(4.5);
  });

  it('弱化文字 ≥ 3:1', () => {
    expect(contrast(theme['--fg-muted'], theme['--bg'])).toBeGreaterThanOrEqual(3);
  });

  // 用例名只是给人看的，取中文那份即可；断言本身与语言无关（查的是色值对比度）
  it.each(GROUPS.map((g) => [translate('zh-CN', g.labelKey), g.cssVar] as const))('%s（%s）达标', (_label, cssVar) => {
    const ratio = contrast(theme[cssVar], theme['--bg']);
    expect(ratio).toBeGreaterThanOrEqual(MUTED.has(cssVar) ? 3 : 4.5);
  });
});

describe('F21 · 分类不只靠颜色', () => {
  it('每组都有符号，且符号来自 §6.2 定义的那 5 个', () => {
    const allowed = new Set(['●', '○', '▶', '⚠', '·']);
    for (const g of GROUPS) {
      expect(g.symbol).toBeTruthy();
      expect(allowed.has(g.symbol)).toBe(true);
    }
  });

  it('★ 符号只有 5 个而分组有 6 个：输入与输出共用 ●', () => {
    // 这是 SPEC §6.3 表格自身的形状，不是实现走样。
    // 灰度下靠什么区分这两组？→ 时间线还有一列中文类型标签（用户/模型…），
    // TimelineRow 把 symbol 与 kindLabel 一起渲染正是为了这个。
    const symbols = GROUPS.map((g) => g.symbol);
    expect(new Set(symbols).size).toBe(5);
    expect(symbols.filter((s) => s === '●')).toHaveLength(2);
  });

  it('(符号, 组名) 组合唯一——灰度下每组仍可辨识', () => {
    // 组名现在是翻译 key（SPEC §15），所以唯一性必须在**每种语言下**分别成立：
    // 只查 key 唯一是不够的，两个不同的 key 完全可能翻成同一个词。
    for (const locale of LOCALES) {
      const pairs = GROUPS.map((g) => `${g.symbol}${translate(locale, g.labelKey)}`);
      expect(new Set(pairs).size, `locale=${locale}`).toBe(GROUPS.length);
    }
  });

  it('12 个 kind 全部映射得到分组，没有落空的（宽松解析的显示侧）', () => {
    const kinds: EntryKind[] = [
      'session', 'context', 'user', 'assistant', 'reasoning', 'tool_call',
      'tool_out', 'lifecycle', 'usage', 'state', 'error', 'other',
    ];
    for (const k of kinds) {
      expect(GROUPS.some((g) => g.id === kindToGroup(k))).toBe(true);
    }
  });
});
