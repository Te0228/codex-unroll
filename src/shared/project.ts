/**
 * 会话的「项目」身份（SPEC §12 Q3）。
 *
 * ★ 为什么不用 cwd 当分组键：
 *   实测 `cwd = /Users/dev/workspace/codex/codex-rs`，而仓库是 `openai/codex`。
 *   Codex 在哪个目录起会话，cwd 就是哪个——同一仓库的 `codex-rs` / `codex-cli` /
 *   根目录各起过会话的话，按 cwd 分组会把**一个项目劈成三组**。
 *   所以分组键优先用 `session_meta.payload.git.repository_url`，没有 git 才退回 cwd。
 */
import type { MsgKey } from './i18n';

export interface ProjectRef {
  /** 分组键，用于聚合与排序。同一项目必须稳定相等 */
  key: string;
  /**
   * 展示名，左栏组头显示。尽量短——左栏只有 240px。
   * ★ 这里放的是**数据**（`owner/repo` 或目录末两段），任何语言下都原样显示。
   *   唯一需要翻译的是「未知项目」，它走 `labelKey`，见下。
   */
  label: string;
  /**
   * 有值时用它翻译出组头文案，`label` 作废。只有「认不出是哪个项目」这一种情况用到。
   * 分成两个字段而不是把 `label` 变成 `Text`，是为了不让翻译类型渗进
   * 分组与排序那条链路——那条链路只关心字符串。
   */
  labelKey?: MsgKey;
  /** 是 git 仓库还是裸目录，UI 可据此换图标 */
  kind: 'git' | 'dir' | 'unknown';
}

export const UNKNOWN_PROJECT: ProjectRef = {
  key: '',
  label: '',
  labelKey: 'project.unknown',
  kind: 'unknown',
};

/**
 * 归一化 git 远端 URL 到 `host/owner/repo`。
 * 覆盖 https / ssh / scp 三种写法，去掉 `.git`、端口、用户名、尾斜杠。
 */
function normalizeGitUrl(raw: string): { key: string; label: string } | null {
  let s = raw.trim();
  if (!s) return null;

  // scp 写法：git@github.com:openai/codex.git
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(s);
  let host: string;
  let pathPart: string;

  if (scp) {
    host = scp[1];
    pathPart = scp[2];
  } else {
    // 带 scheme 的写法；也容忍 //host/path 和裸 host/path
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^\/\//, '');
    const at = s.indexOf('@');
    const firstSlash = s.indexOf('/');
    if (at !== -1 && (firstSlash === -1 || at < firstSlash)) s = s.slice(at + 1);
    const slash = s.indexOf('/');
    if (slash === -1) return null;
    host = s.slice(0, slash);
    pathPart = s.slice(slash + 1);
  }

  host = host.replace(/:\d+$/, '').toLowerCase();
  pathPart = pathPart.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
  if (!host || !pathPart) return null;

  const segs = pathPart.split('/').filter(Boolean);
  if (segs.length === 0) return null;

  return {
    key: `git:${host}/${segs.join('/')}`,
    // 展示取最后两段（owner/repo）；只有一段就用那一段
    label: segs.slice(-2).join('/'),
  };
}

/**
 * 目录的展示名取**末两段**，不是 basename。
 *
 * 只取 basename 的话 `~/a/scratch` 和 `~/b/scratch` 会渲染成两个一模一样的组头，
 * 肉眼完全分不出是哪个——而组头是唯一的区分线索。
 * 末两段既能区分，形状也和 git 的 `owner/repo` 一致。
 */
function dirLabel(p: string): string {
  const segs = p.split(/[/\\]+/).filter(Boolean);
  if (segs.length === 0) return p;
  return segs.slice(-2).join('/');
}

/**
 * 从 `session_meta` 的 cwd + git.repository_url 推导项目身份。
 * 两者都缺时返回 UNKNOWN_PROJECT——**绝不抛异常**（§3.4 宽松解析）。
 */
export function projectRef(cwd?: string, repositoryUrl?: string): ProjectRef {
  if (repositoryUrl) {
    const g = normalizeGitUrl(repositoryUrl);
    if (g) return { key: g.key, label: g.label, kind: 'git' };
  }
  if (cwd && cwd.trim()) {
    const c = cwd.trim();
    return { key: `dir:${c}`, label: dirLabel(c) || c, kind: 'dir' };
  }
  return UNKNOWN_PROJECT;
}
