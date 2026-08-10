/**
 * 左栏分组的纯函数层（SPEC §12 Q3）。
 * 组件层（组头是否渲染、折叠持久化）在 App.test.tsx 里测。
 */
import { describe, expect, it } from 'vitest';
import type { ProjectRef, SessionListItem } from '../shared/types';
import { ref, resolve } from '../shared/i18n';
import { UNKNOWN_KEY, groupKeyOf, groupSessions, matchesSession } from './sessionGroups';

const CODEX: ProjectRef = { key: 'git:github.com/openai/codex', label: 'openai/codex', kind: 'git' };
const DEMO: ProjectRef = { key: 'git:example.com/x/demo', label: 'x/demo', kind: 'git' };
const SCRATCH: ProjectRef = { key: 'dir:/Users/dev/scratch', label: 'scratch', kind: 'dir' };

function s(path: string, mtime: number, project?: ProjectRef, extra: Partial<SessionListItem> = {}): SessionListItem {
  return { path, mtime, size: 1024, project, ...extra };
}

describe('groupSessions · 分组与排序', () => {
  it('按 project.key 聚合，组内按 mtime 倒序', () => {
    const groups = groupSessions([
      s('/a.jsonl', 300, CODEX),
      s('/b.jsonl', 100, CODEX),
      s('/c.jsonl', 200, CODEX),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map((i) => i.path)).toEqual(['/a.jsonl', '/c.jsonl', '/b.jsonl']);
    expect(groups[0].label).toBe('openai/codex');
    expect(groups[0].kind).toBe('git');
  });

  /** 这条是分组设计的核心性质，改成字母序就废了 */
  it('组间按「组内最新 mtime」倒序 —— 第一组第一条仍是全局最新', () => {
    const all = [
      s('/codex-old.jsonl', 100, CODEX),
      s('/codex-mid.jsonl', 500, CODEX),
      s('/demo-new.jsonl', 900, DEMO),
      s('/scratch.jsonl', 700, SCRATCH),
    ];
    const groups = groupSessions(all);
    expect(groups.map((g) => g.label)).toEqual(['x/demo', 'scratch', 'openai/codex']);
    expect(groups[0].items[0].path).toBe('/demo-new.jsonl');
    const newest = [...all].sort((a, b) => b.mtime - a.mtime)[0];
    expect(groups[0].items[0].path).toBe(newest.path);
  });

  it('project 缺失归入「未知项目」，且永远排最后（哪怕它最新）', () => {
    const groups = groupSessions([
      s('/nometa.jsonl', 9999),
      s('/codex.jsonl', 100, CODEX),
      s('/demo.jsonl', 50, DEMO),
    ]);
    // ★ 组头文案分两条路（SPEC §15.1）：项目名是**数据**放 `label`，
    //   「未知项目」是**文案**放 `labelKey`，渲染层才翻。所以这里 label 是空串。
    expect(groups.map((g) => g.label)).toEqual(['openai/codex', 'x/demo', '']);
    expect(groups.map((g) => g.labelKey)).toEqual([undefined, undefined, 'project.unknown']);
    expect(resolve('zh-CN', ref('project.unknown'))).toBe('未知项目');
    const last = groups[groups.length - 1];
    expect(last.key).toBe(UNKNOWN_KEY);
    expect(last.unknown).toBe(true);
    expect(last.kind).toBe('unknown');
  });

  it('project 存在但 key 为空（UNKNOWN_PROJECT）同样算未知，与缺失项合并为一组', () => {
    const groups = groupSessions([
      s('/x.jsonl', 2, { key: '', label: '未知项目', kind: 'unknown' }),
      s('/y.jsonl', 1),
      s('/z.jsonl', 3, CODEX),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[1].key).toBe(UNKNOWN_KEY);
    expect(groups[1].items.map((i) => i.path)).toEqual(['/x.jsonl', '/y.jsonl']);
  });

  it('mtime 相同的组按 label 定序，渲染顺序稳定', () => {
    const a = groupSessions([s('/1.jsonl', 5, DEMO), s('/2.jsonl', 5, CODEX)]);
    const b = groupSessions([s('/2.jsonl', 5, CODEX), s('/1.jsonl', 5, DEMO)]);
    expect(a.map((g) => g.key)).toEqual(b.map((g) => g.key));
  });

  it('空输入返回空数组，不抛', () => {
    expect(groupSessions([])).toEqual([]);
  });
});

describe('groupKeyOf · 与 groupSessions 用同一套未知判定', () => {
  it('有 project 用 project.key', () => {
    expect(groupKeyOf(s('/a.jsonl', 1, CODEX))).toBe(CODEX.key);
  });

  it('缺 project 或 key 为空一律落到 UNKNOWN_KEY', () => {
    expect(groupKeyOf(s('/a.jsonl', 1))).toBe(UNKNOWN_KEY);
    expect(groupKeyOf(s('/a.jsonl', 1, { key: '', label: '未知项目', kind: 'unknown' }))).toBe(UNKNOWN_KEY);
  });

  it('与 groupSessions 分出来的组键一致', () => {
    const items = [s('/a.jsonl', 1, CODEX), s('/b.jsonl', 2), s('/c.jsonl', 3, SCRATCH)];
    const keys = new Set(groupSessions(items).map((g) => g.key));
    for (const it of items) expect(keys.has(groupKeyOf(it))).toBe(true);
  });
});

describe('matchesSession · 过滤同时匹配项目名', () => {
  const it1 = s('/sessions/2026/rollout-aaa.jsonl', 1, CODEX, {
    model: 'deepseek-v4-flash',
    firstUser: '创建一个 hello.txt',
    cwd: '/Users/dev/workspace/codex/codex-rs',
  });

  it('空查询全通过', () => {
    expect(matchesSession(it1, '')).toBe(true);
    expect(matchesSession(it1, '   ')).toBe(true);
  });

  it('原有的 path / model / firstUser / cwd 仍然匹配', () => {
    expect(matchesSession(it1, 'rollout-aaa')).toBe(true);
    expect(matchesSession(it1, 'deepseek')).toBe(true);
    expect(matchesSession(it1, 'hello.txt')).toBe(true);
    expect(matchesSession(it1, 'codex-rs')).toBe(true);
  });

  it('项目名命中 —— 会话本身的字段里没有这个词也算命中', () => {
    const bare = s('/sessions/2026/rollout-bbb.jsonl', 1, CODEX);
    expect(matchesSession(bare, 'openai')).toBe(true);
    expect(matchesSession(bare, 'OPENAI/CODEX')).toBe(true);
    // 命中的是 project.label / key，不是路径
    expect(bare.path.toLowerCase()).not.toContain('openai');
  });

  it('不相干的词不命中', () => {
    expect(matchesSession(it1, 'zzz-nothing')).toBe(false);
  });
});
