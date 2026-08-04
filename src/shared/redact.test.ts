/**
 * SPEC §14.2 B 组（10 条）+ §9.1 的脱敏单测。
 *
 * 期望值全部来自 SPEC / test/fixtures/README.md，**实现对不上就是实现错了**，
 * 不要回过头来改期望值。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { MASK, isRedacted, redactDeep, redactText } from './redact';
import { toEntries } from './rollout';
import type { Entry, RolloutRecord } from './types';

function readFixtureLines(name: string): string[] {
  const path = fileURLToPath(new URL(`../../test/fixtures/${name}`, import.meta.url));
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  // 文件以换行结尾会多出一个空元素，那不是「一行」
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

const EDGE = toEntries(readFixtureLines('03-edge-cases.jsonl'));

function payloadOf(e: Entry): Record<string, unknown> {
  return ((e.raw as RolloutRecord).payload ?? {}) as Record<string, unknown>;
}

/** 03 号夹具里所有假 key 的可识别片段，一个都不许出现在输出里 */
const FAKE_FRAGMENTS = [
  'FAKEkeyDoNotUse',
  'FAKEsecond',
  'FAKEinline',
  'FAKEsig',
  'FAKE0000000000000000000000000000wz90',
  'sk-FAKEkeyDoNotUse00000000000000ab12',
  'AKIAIOSFODNN7EXAMPLE',
  'eyJhbGciOiJIUzI1NiJ9',
];

describe('§9.1 遮蔽字符', () => {
  it('是 U+2022 BULLET，正好 4 个', () => {
    expect(MASK).toBe('••••');
    expect(MASK).toHaveLength(4);
  });
});

describe('B. 密钥脱敏 —— 03-edge-cases.jsonl', () => {
  const sessionMeta = EDGE[0];
  const userMessage = EDGE[2];
  const devMessage = EDGE[3];

  it('B1 · session_meta.payload.OPENAI_API_KEY（字段名命中）→ sk-••••ab12', () => {
    expect(sessionMeta.topType).toBe('session_meta');
    expect(payloadOf(sessionMeta).OPENAI_API_KEY).toBe('sk-••••ab12');
  });

  it('B2 · session_meta.payload.api_key（字段名命中）→ sk-••••cd34', () => {
    expect(payloadOf(sessionMeta).api_key).toBe('sk-••••cd34');
  });

  it('B3 · user_message.message 正文内嵌（值形态命中）→ sk-••••ef56', () => {
    expect(userMessage.payloadType).toBe('user_message');
    expect(userMessage.preview).toBe('帮我用这个 key 调接口 sk-••••ef56 谢谢');
  });

  it('B4 · Bearer JWT → Bearer ••••xy78', () => {
    expect(devMessage.preview).toContain('Bearer ••••xy78');
    expect(devMessage.preview).not.toContain('eyJ');
  });

  it('B5 · AWS Access Key → ••••MPLE', () => {
    expect(devMessage.preview).toContain('AWS=••••MPLE');
    expect(devMessage.preview).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('B6 · GitHub token → ghp_••••wz90', () => {
    expect(devMessage.preview).toContain('GH=ghp_••••wz90');
  });

  it('B7 · rawPretty 同样被脱敏（最关键的一条）', () => {
    const allRaw = EDGE.map((e) => e.rawPretty).join('\n');
    expect(allRaw.indexOf('FAKEkeyDoNotUse')).toBe(-1);
    for (const frag of FAKE_FRAGMENTS) {
      expect(allRaw).not.toContain(frag);
    }
    // 遮蔽后的写法确实落在了原始 JSON 面板里
    expect(sessionMeta.rawPretty).toContain('sk-••••ab12');
  });

  it('B8 · preview / title 同样被脱敏', () => {
    const allText = EDGE.map((e) => `${e.title}\n${e.preview}`).join('\n');
    expect(allText.indexOf('FAKEkeyDoNotUse')).toBe(-1);
    for (const frag of FAKE_FRAGMENTS) {
      expect(allText).not.toContain(frag);
    }
  });

  it('B9 · 普通文本不受影响', () => {
    expect(redactText('帮我用这个 key 调接口')).toBe('帮我用这个 key 调接口');
    expect(redactText('普通文本 hello')).toBe('普通文本 hello');
    expect(userMessage.preview).toContain('帮我用这个 key 调接口');
  });

  it('B10 · 脱敏后仍可搜索尾 4 位，搜 ab12 命中 B1 那条', () => {
    const hits = EDGE.filter(
      (e) => e.rawPretty.includes('ab12') || e.preview.includes('ab12') || e.title.includes('ab12'),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toBe(sessionMeta);
  });
});

describe('§9.1 redactText · 逐个形态', () => {
  it('OpenAI 风格保留 sk- 前缀与尾 4 位', () => {
    expect(redactText('sk-FAKEdocsExample00000000000b6b2')).toBe('sk-••••b6b2');
    expect(redactText('sk-FAKEkeyDoNotUse00000000000000ab12')).toBe('sk-••••ab12');
  });

  it('Bearer 保留前缀，JWT 单独出现时整体遮蔽', () => {
    expect(
      redactText('Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.FAKEsig00000000xy78'),
    ).toBe('Bearer ••••xy78');
    expect(redactText('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.FAKEsig00000000xy78')).toBe('••••xy78');
  });

  it('AWS 无前缀分隔符，不保留前缀', () => {
    expect(redactText('AKIAIOSFODNN7EXAMPLE')).toBe('••••MPLE');
  });

  it('GitHub token 保留 4 字前缀', () => {
    expect(redactText('ghp_FAKE0000000000000000000000000000wz90')).toBe('ghp_••••wz90');
    expect(redactText('gho_FAKE0000000000000000000000000000wz90')).toBe('gho_••••wz90');
  });

  it('空串与不含密钥的串原样返回', () => {
    expect(redactText('')).toBe('');
    expect(redactText('sk-tooshort')).toBe('sk-tooshort');
    expect(redactText('AKIA123')).toBe('AKIA123');
  });
});

describe('§9.1 redactDeep · 字段名策略', () => {
  it('字段名命中但值不匹配已知形态时，用通用 •••• + 尾 4 位', () => {
    const out = redactDeep({ password: 'hunter2-plaintext', note: 'hunter2-plaintext' });
    expect(out.password).toBe('••••text');
    // 字段名没命中、值形态也没命中 → 原样
    expect(out.note).toBe('hunter2-plaintext');
  });

  it('≤4 位的敏感值全遮，不泄露原文', () => {
    expect(redactDeep({ secret: 'abcd' }).secret).toBe('••••');
    expect(redactDeep({ secret: '' }).secret).toBe('••••');
  });

  it('敏感字段下的整棵子树都被遮蔽，数组也覆盖', () => {
    const out = redactDeep({
      credential: { nested: ['token-value-aaaa', { deep: 'token-value-bbbb' }] },
    });
    expect(out.credential.nested[0]).toBe('••••aaaa');
    expect((out.credential.nested[1] as { deep: string }).deep).toBe('••••bbbb');
  });

  it('返回新对象，不改原对象', () => {
    const input = { api_key: 'sk-FAKEkeyDoNotUse00000000000000ab12', nested: { a: 1 } };
    const out = redactDeep(input);
    expect(input.api_key).toBe('sk-FAKEkeyDoNotUse00000000000000ab12');
    expect(out.api_key).toBe('sk-••••ab12');
    expect(out).not.toBe(input);
    expect(out.nested).not.toBe(input.nested);
  });

  it('非字符串标量原样保留，null 不崩', () => {
    const out = redactDeep({ n: 1, b: true, z: null, u: undefined, arr: [1, null] });
    expect(out).toEqual({ n: 1, b: true, z: null, u: undefined, arr: [1, null] });
    expect(redactDeep(null)).toBeNull();
    expect(redactDeep(42)).toBe(42);
    expect(redactDeep('sk-FAKEkeyDoNotUse00000000000000ab12')).toBe('sk-••••ab12');
  });

  it('isRedacted 认得遮蔽标记', () => {
    expect(isRedacted('sk-••••ab12')).toBe(true);
    expect(isRedacted('普通文本')).toBe(false);
  });
});
