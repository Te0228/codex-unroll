/**
 * 项目身份（SPEC §12 Q3）。
 *
 * ★ 本地化之后的口径：`label` 里放的是**数据**（`owner/repo` 或目录末两段），
 *   任何语言下都原样显示；唯一需要翻译的是「未知项目」，它走 `labelKey`。
 *   所以 git / dir 两条路径上 `labelKey` 必须**不存在**——一旦冒出来，
 *   组头就会把真实项目名换成一句翻译。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from './i18n';
import { projectRef, UNKNOWN_PROJECT } from './project';

describe('projectRef · git 优先', () => {
  it('https 形式 → host/owner/repo，展示 owner/repo', () => {
    const p = projectRef('/Users/dev/workspace/codex/codex-rs', 'https://github.com/openai/codex.git');
    expect(p).toEqual({ key: 'git:github.com/openai/codex', label: 'openai/codex', kind: 'git' });
  });

  it('★ 同一仓库的不同子目录归为同一组（这正是不用 cwd 当键的理由）', () => {
    const a = projectRef('/Users/dev/workspace/codex/codex-rs', 'https://github.com/openai/codex.git');
    const b = projectRef('/Users/dev/workspace/codex/codex-cli', 'https://github.com/openai/codex.git');
    const c = projectRef('/Users/dev/workspace/codex', 'https://github.com/openai/codex.git');
    expect(a.key).toBe(b.key);
    expect(b.key).toBe(c.key);
  });

  it('scp 形式 git@host:owner/repo.git 与 https 归一到同一个键', () => {
    expect(projectRef(undefined, 'git@github.com:openai/codex.git').key).toBe(
      projectRef(undefined, 'https://github.com/openai/codex.git').key,
    );
  });

  it('ssh:// 形式、带端口、带用户名，也归一到同一个键', () => {
    for (const url of [
      'ssh://git@github.com/openai/codex.git',
      'ssh://git@github.com:22/openai/codex.git',
      'https://user@github.com/openai/codex',
      'https://github.com/openai/codex/',
      'HTTPS://GitHub.com/openai/codex.GIT',
    ]) {
      expect(projectRef(undefined, url).key, url).toBe('git:github.com/openai/codex');
    }
  });

  it('嵌套路径（GitLab 子组）保留全路径当键，展示只取末两段', () => {
    const p = projectRef(undefined, 'https://gitlab.com/group/sub/proj.git');
    expect(p.key).toBe('git:gitlab.com/group/sub/proj');
    expect(p.label).toBe('sub/proj');
  });

  it('单段路径（03 号夹具那种）不崩，展示就是那一段', () => {
    const p = projectRef('/Users/dev/proj', 'https://example.com/x.git');
    expect(p).toEqual({ key: 'git:example.com/x', label: 'x', kind: 'git' });
  });
});

describe('projectRef · 退回 cwd', () => {
  it('无 git 时用 cwd，展示末两段', () => {
    expect(projectRef('/Users/dev/workspace/myproj')).toEqual({
      key: 'dir:/Users/dev/workspace/myproj',
      label: 'workspace/myproj',
      kind: 'dir',
    });
  });

  it('★ 同名目录在不同父目录下，组头必须能区分（不能只取 basename）', () => {
    const a = projectRef('/Users/dev/a/scratch');
    const b = projectRef('/Users/dev/b/scratch');
    expect(a.key).not.toBe(b.key);
    expect(a.label).not.toBe(b.label);
    expect([a.label, b.label]).toEqual(['a/scratch', 'b/scratch']);
  });

  it('只有一段的路径不崩', () => {
    expect(projectRef('/proj').label).toBe('proj');
  });

  it('git URL 畸形时退回 cwd，而不是产生垃圾键', () => {
    for (const bad of ['', '   ', 'not a url', 'https://', '///']) {
      expect(projectRef('/Users/dev/p', bad).kind, JSON.stringify(bad)).toBe('dir');
    }
  });

  it('尾斜杠不影响展示名；Windows 路径也认', () => {
    expect(projectRef('/Users/dev/myproj/').label).toBe('dev/myproj');
    expect(projectRef('C:\\work\\myproj').label).toBe('work/myproj');
  });

  it('两者都缺 → UNKNOWN_PROJECT，不抛异常', () => {
    expect(projectRef()).toEqual(UNKNOWN_PROJECT);
    expect(projectRef('', '')).toEqual(UNKNOWN_PROJECT);
  });
});

describe('projectRef · 展示名的两条路：数据走 label，文案走 labelKey', () => {
  it('UNKNOWN_PROJECT 的展示名是翻译 key，不是烤死的中文', () => {
    expect(UNKNOWN_PROJECT).toEqual({
      key: '',
      label: '',
      labelKey: 'project.unknown',
      kind: 'unknown',
    });
    // 原来烤在这里的那句中文，现在由目录给出
    expect(resolve('zh-CN', { key: UNKNOWN_PROJECT.labelKey! })).toBe('未知项目');
    expect(resolve('en', { key: UNKNOWN_PROJECT.labelKey! })).toBe('Unknown project');
  });

  it('git / dir 两条路径都**没有** labelKey——项目名是数据，不该被翻译', () => {
    const git = projectRef('/Users/dev/workspace/codex/codex-rs', 'https://github.com/openai/codex.git');
    const dir = projectRef('/Users/dev/workspace/myproj');
    expect(git.labelKey).toBeUndefined();
    expect(dir.labelKey).toBeUndefined();
    expect(git.label).toBe('openai/codex');
    expect(dir.label).toBe('workspace/myproj');
  });
});

describe('projectRef · 对着真实夹具跑', () => {
  const metaOf = (f: string) =>
    JSON.parse(readFileSync(`test/fixtures/${f}`, 'utf8').split('\n')[0]).payload;

  it('01 与 02 同属 openai/codex（cwd 相同、git 相同）', () => {
    const a = projectRef(metaOf('01-apply-patch-rejected.jsonl').cwd, metaOf('01-apply-patch-rejected.jsonl').git?.repository_url);
    const b = projectRef(metaOf('02-exec-command.jsonl').cwd, metaOf('02-exec-command.jsonl').git?.repository_url);
    expect(a.key).toBe('git:github.com/openai/codex');
    expect(a.key).toBe(b.key);
    expect(a.label).toBe('openai/codex');
  });

  it('03 是另一个项目', () => {
    const m = metaOf('03-edge-cases.jsonl');
    const p = projectRef(m.cwd, m.git?.repository_url);
    expect(p.key).toBe('git:example.com/x');
    expect(p.key).not.toBe('git:github.com/openai/codex');
  });
});
