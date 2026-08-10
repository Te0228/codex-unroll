/**
 * SPEC §15 本地化的验收。
 *
 * ★ 这一组里最重要的是第一条：**两份目录的 key 集合必须完全一致**。
 *   `ZH` 被标注成 `Record<MsgKey, Msg>`，少一个 key 编译就过不去——但类型
 *   拦不住有人用 `as` 绕过去，所以运行时还要再钉一遍。缺 key 的后果不是报错，
 *   是界面上悄悄冒出英文原文或 `ui.someKey`，靠肉眼很难发现。
 *
 * 其余几条围绕同一个原则：**取词永不抛异常、永不返回空白**（§6.0 摊开，不是隐藏）。
 * 参数缺失时目录函数走 joinParts 的口径——空片段整个丢掉，不留悬空的 ` · `。
 *
 * 所有渲染断言都**显式指定语言**，不依赖 navigator / 环境默认。
 */
import { describe, expect, it } from 'vitest';

import {
  CATALOG,
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_KEY,
  LOCALE_NAME,
  asLocalePref,
  isMsgRef,
  localeFromLanguage,
  ref,
  resolve,
  resolveLocale,
  translate,
} from './i18n';
import type { Locale, MsgKey } from './i18n';

const keysOf = (locale: Locale): string[] => Object.keys(CATALOG[locale]).toSorted();

// ─────────────────────────────────────────────────────────────
// ★ 目录完整性
// ─────────────────────────────────────────────────────────────

describe('★ 两份目录的 key 集合完全一致', () => {
  it('EN 有的 ZH 必须有，ZH 有的 EN 也必须有', () => {
    const en = keysOf('en');
    const zh = keysOf('zh-CN');
    // 先给出可读的差集，再整体比对——挂了能一眼看出少了哪几条
    expect(en.filter((k) => !zh.includes(k))).toEqual([]);
    expect(zh.filter((k) => !en.includes(k))).toEqual([]);
    expect(zh).toEqual(en);
  });

  it('条目数一致且不为空', () => {
    expect(keysOf('en').length).toBe(keysOf('zh-CN').length);
    expect(keysOf('en').length).toBeGreaterThan(0);
  });

  it('同一个 key 在两份目录里「是不是带参数的」必须一致', () => {
    // 一边是函数一边是常量，等于有一种语言把参数吞了——渲染出来会缺信息
    for (const key of keysOf('en') as MsgKey[]) {
      expect(typeof CATALOG['zh-CN'][key], key).toBe(typeof CATALOG.en[key]);
    }
  });

  it('参数给全时，没有一条文案渲染成空白（宁可显示 key，也不许显示空）', () => {
    // 目录里所有出现过的参数名，一次性喂满——只有「参数全缺」才允许出空串，
    // 那是 preview.* 的合法退化（这一条不测那个场景，见下面的降级组）
    const all = {
      n: 1, tool: 'x', lineno: 1, dir: 'd', label: 'l', value: 'v', no: 1,
      visible: 1, total: 2, duration: 12, ttft: 3, message: 'm', input: 5, output: 6,
    };
    for (const locale of LOCALES) {
      for (const key of keysOf(locale) as MsgKey[]) {
        expect(translate(locale, key, all), `${locale}/${key}`).not.toBe('');
      }
    }
  });

  it('LOCALES / LOCALE_NAME / CATALOG 三者覆盖同一批语言', () => {
    expect(LOCALES).toEqual(['en', 'zh-CN']);
    expect(Object.keys(CATALOG).toSorted()).toEqual([...LOCALES].toSorted());
    expect(Object.keys(LOCALE_NAME).toSorted()).toEqual([...LOCALES].toSorted());
    // 语言名永远用它自己的语言写，不翻译
    expect(LOCALE_NAME).toEqual({ en: 'English', 'zh-CN': '中文' });
    expect(DEFAULT_LOCALE).toBe('en');
  });
});

// ─────────────────────────────────────────────────────────────
// 带参数的目录项
// ─────────────────────────────────────────────────────────────

describe('带参数的目录项渲染', () => {
  it('entry.toolCall · 工具名是数据，箭头是排版', () => {
    expect(translate('zh-CN', 'entry.toolCall', { tool: 'apply_patch' })).toBe('→ apply_patch');
    expect(translate('en', 'entry.toolCall', { tool: 'apply_patch' })).toBe('→ apply_patch');
    // 工具名一个字符都不许被翻译或改写
    expect(translate('zh-CN', 'entry.toolCall', { tool: 'exec_command' })).toBe('→ exec_command');
  });

  it('entry.parseErrorAt · 行号走参数，句子留在目录', () => {
    expect(translate('zh-CN', 'entry.parseErrorAt', { lineno: 7 })).toBe('解析失败（第 7 行）');
    expect(translate('en', 'entry.parseErrorAt', { lineno: 7 })).toBe('Parse error (line 7)');
  });

  it('preview.taskComplete · 时长 + 首字 + 模型原话', () => {
    const p = { duration: 14058, ttft: 3936, message: '改完了' };
    expect(translate('zh-CN', 'preview.taskComplete', p)).toBe('14058ms · 首字 3936ms · 改完了');
    expect(translate('en', 'preview.taskComplete', p)).toBe('14058ms · first token 3936ms · 改完了');
  });

  it('preview.tokenCount · 数字走参数（14.2 C11 的 34188 / 263）', () => {
    const p = { input: 34188, output: 263 };
    expect(translate('zh-CN', 'preview.tokenCount', p)).toBe('输入 34188 · 输出 263');
    expect(translate('en', 'preview.tokenCount', p)).toBe('in 34188 · out 263');
  });
});

// ─────────────────────────────────────────────────────────────
// 参数缺失时的降级
// ─────────────────────────────────────────────────────────────

/**
 * 拼接结果里不许有空片段、也不许有悬空的分隔符。
 * 参数一个都没有时整体是空串——那是「没东西可显示」，不是「拼坏了」，直接放行。
 */
function expectNoDanglingSeparator(s: string): void {
  if (s === '') return;
  expect(s.startsWith('·')).toBe(false);
  expect(s.endsWith('·')).toBe(false);
  expect(s).not.toContain(' ·  · ');
  expect(s).not.toMatch(/^\s|\s$/);
  expect(s.split(' · ').every((part) => part.trim() !== '')).toBe(true);
}

describe('参数缺失时的降级（joinParts 口径：空片段整个丢掉）', () => {
  it('preview.taskComplete · 只有 duration，没有 ttft / message', () => {
    for (const locale of LOCALES) {
      const out = translate(locale, 'preview.taskComplete', { duration: 12 });
      expect(out, locale).toBe('12ms');
      expectNoDanglingSeparator(out);
    }
  });

  it('preview.taskComplete · 只有 message（模型说了话但没报时长）', () => {
    expect(translate('zh-CN', 'preview.taskComplete', { message: '好了' })).toBe('好了');
    expectNoDanglingSeparator(translate('en', 'preview.taskComplete', { message: 'done' }));
  });

  it('preview.taskComplete · 缺中间那段：duration + message，ttft 缺席', () => {
    for (const locale of LOCALES) {
      const out = translate(locale, 'preview.taskComplete', { duration: 12, message: 'ok' });
      expect(out, locale).toBe('12ms · ok');
      expectNoDanglingSeparator(out);
    }
  });

  it('preview.tokenCount · 只有 input 或只有 output', () => {
    expect(translate('zh-CN', 'preview.tokenCount', { input: 5 })).toBe('输入 5');
    expect(translate('zh-CN', 'preview.tokenCount', { output: 6 })).toBe('输出 6');
    expect(translate('en', 'preview.tokenCount', { input: 5 })).toBe('in 5');
    expect(translate('en', 'preview.tokenCount', { output: 6 })).toBe('out 6');
    for (const locale of LOCALES) {
      expectNoDanglingSeparator(translate(locale, 'preview.tokenCount', { input: 5 }));
      expectNoDanglingSeparator(translate(locale, 'preview.tokenCount', { output: 6 }));
    }
  });

  it('参数全缺时返回空串也不崩——这是目录函数的边界，不是取词的边界', () => {
    for (const locale of LOCALES) {
      expect(() => translate(locale, 'preview.taskComplete')).not.toThrow();
      expect(() => translate(locale, 'preview.tokenCount', {})).not.toThrow();
      expectNoDanglingSeparator(translate(locale, 'preview.tokenCount', {}));
    }
  });

  it('参数没用到的目录项，多给参数也无害', () => {
    expect(translate('zh-CN', 'entry.user', { tool: 'x' })).toBe('用户');
  });
});

// ─────────────────────────────────────────────────────────────
// translate / resolve 的兜底
// ─────────────────────────────────────────────────────────────

describe('translate · 永不抛异常', () => {
  // 类型上不存在的 key 只能用 as 造出来——现实里它来自「目录被人漏改了一处」
  const ghost = 'ui.thisKeyDoesNotExist' as MsgKey;

  it('不存在的 key 不抛异常，回显 key 本身而不是空白', () => {
    for (const locale of LOCALES) {
      expect(() => translate(locale, ghost)).not.toThrow();
      expect(translate(locale, ghost)).toBe('ui.thisKeyDoesNotExist');
      expect(translate(locale, ghost)).not.toBe('');
    }
  });

  it('不认识的语言退回英文目录，不抛异常', () => {
    const fake = 'de-DE' as Locale;
    expect(() => translate(fake, 'entry.user')).not.toThrow();
    expect(translate(fake, 'entry.user')).toBe('User');
    expect(translate(fake, 'entry.toolCall', { tool: 'shell' })).toBe('→ shell');
  });

  it('缺参数的带参目录项不抛异常', () => {
    expect(() => translate('zh-CN', 'entry.toolCall')).not.toThrow();
    expect(() => translate('en', 'entry.parseErrorAt', {})).not.toThrow();
  });
});

describe('resolve · 纯数据原样返回', () => {
  it('字符串原样返回，一个字符都不动', () => {
    for (const locale of LOCALES) {
      expect(resolve(locale, 'exec_command')).toBe('exec_command');
      expect(resolve(locale, '')).toBe('');
      // 长得像 key 的字符串也是数据，不许被当成 key 去查目录
      expect(resolve(locale, 'entry.user')).toBe('entry.user');
    }
  });

  it('MsgRef 走 translate', () => {
    expect(resolve('zh-CN', { key: 'entry.user' })).toBe('用户');
    expect(resolve('en', { key: 'entry.user' })).toBe('User');
    expect(resolve('zh-CN', ref('entry.toolCall', { tool: 'shell' }))).toBe('→ shell');
  });

  it('ref · 无参数时不塞 params 字段（方便测试直接深比对）', () => {
    expect(ref('entry.user')).toEqual({ key: 'entry.user' });
    expect(Object.hasOwn(ref('entry.user'), 'params')).toBe(false);
    expect(ref('entry.toolCall', { tool: 'x' })).toEqual({
      key: 'entry.toolCall',
      params: { tool: 'x' },
    });
  });

  it('isMsgRef 认得出两种 Text', () => {
    expect(isMsgRef({ key: 'entry.user' })).toBe(true);
    expect(isMsgRef('entry.user')).toBe(false);
    expect(isMsgRef('')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// 语言判定
// ─────────────────────────────────────────────────────────────

describe('localeFromLanguage · BCP-47 标签 → 支持的语言', () => {
  it('中文各种写法都落到 zh-CN（繁体也落简体：给繁体用户看简体好过看英文）', () => {
    for (const tag of ['zh', 'zh-CN', 'zh-Hans-CN', 'zh-TW', 'zh-Hant', 'ZH-cn', ' zh-CN ']) {
      expect(localeFromLanguage(tag), tag).toBe('zh-CN');
    }
  });

  it('英文各种写法落到 en', () => {
    for (const tag of ['en', 'en-US', 'en-GB', 'EN']) {
      expect(localeFromLanguage(tag), tag).toBe('en');
    }
  });

  it('不支持的语言 / 空值一律回默认英文', () => {
    for (const tag of ['fr', 'fr-FR', 'ja', '', '   ', undefined]) {
      expect(localeFromLanguage(tag), String(tag)).toBe(DEFAULT_LOCALE);
      expect(localeFromLanguage(tag)).toBe('en');
    }
  });
});

describe('resolveLocale · 偏好 + 系统语言', () => {
  it("'system' 分支按系统语言解析", () => {
    expect(resolveLocale('system', 'zh-CN')).toBe('zh-CN');
    expect(resolveLocale('system', 'zh-Hans-CN')).toBe('zh-CN');
    expect(resolveLocale('system', 'en-US')).toBe('en');
    expect(resolveLocale('system', 'fr')).toBe('en');
    expect(resolveLocale('system', undefined)).toBe('en');
  });

  it('显式分支压过系统语言——用户选了就是选了', () => {
    expect(resolveLocale('en', 'zh-CN')).toBe('en');
    expect(resolveLocale('zh-CN', 'en-US')).toBe('zh-CN');
    expect(resolveLocale('zh-CN', undefined)).toBe('zh-CN');
  });
});

describe('asLocalePref · localStorage 里的值兜底', () => {
  it('认得出的两个值原样带出', () => {
    expect(asLocalePref('en')).toBe('en');
    expect(asLocalePref('zh-CN')).toBe('zh-CN');
    expect(asLocalePref('system')).toBe('system');
  });

  it('垃圾输入一律当 system，不抛异常', () => {
    for (const raw of ['', 'zh', 'ZH-CN', 'en-US', 'null', '{}', 'system ', null, undefined]) {
      expect(asLocalePref(raw), JSON.stringify(raw)).toBe('system');
    }
  });

  it('localStorage 的键是共用常量，别各写各的字符串', () => {
    expect(LOCALE_KEY).toBe('unroll:locale');
  });
});
