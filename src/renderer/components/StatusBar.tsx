/**
 * 顶部状态条（§6.1，28px）。
 *
 * ★ 右侧只显示 3 个值：model · approval · sandbox（F4）。
 *   旧设计的 11 个摘要卡片区已废除——它占了最贵的空间去展示整场不变的值（F5）。
 *   provider / effort / 耗时 / token 挪到「选中会话头条目时的详情面板」（F8）。
 *
 * ★ 左侧文件名右边挂**项目身份**（§12 Q3）。
 *   左栏的组头能回答「这是哪个仓库」，但 ⌘1 一折叠就没了；
 *   而状态条中间本来就是一大片空白。悬停 title 给完整 cwd——
 *   用户要的是「项目的实际目录」，不是一个缩短过的展示名。
 */
import type { SessionSummary } from '../../shared/types';
import { projectRef } from '../../shared/project';

export interface StatusBarProps {
  fileName: string;
  summary: SessionSummary | null;
  onReveal?: () => void;
}

/** 图标只表身份类型，形状独立于颜色（灰度下也能区分，同 F21） */
const KIND_ICON = { git: '⎇', dir: '▤', unknown: '·' } as const;

export function StatusBar({ fileName, summary, onReveal }: StatusBarProps) {
  // cwd / repositoryUrl 都缺时 projectRef 返回 UNKNOWN_PROJECT，
  // 显示「未知项目」而不是 undefined
  const project = summary ? projectRef(summary.cwd, summary.repositoryUrl) : null;
  const projectTitle = summary
    ? [summary.cwd, summary.repositoryUrl].filter(Boolean).join('\n') || project!.label
    : '';

  return (
    <header className="statusbar" data-testid="statusbar">
      <span className="sb-file">{fileName || 'codex-unroll'}</span>

      {project && (
        <span className="sb-project" data-testid="statusbar-project" title={projectTitle}>
          <span className="sb-project-icon" aria-hidden="true">
            {KIND_ICON[project.kind]}
          </span>
          <span className="sb-project-label">{project.label}</span>
          {summary?.branch && (
            <span className="sb-branch" data-testid="statusbar-branch">
              @{summary.branch}
            </span>
          )}
        </span>
      )}

      {summary ? (
        <span className="sb-meta" data-testid="statusbar-meta">
          <span>{summary.model || '—'}</span>
          <span className="sb-sep">·</span>
          <span>{summary.approval || '—'}</span>
          <span className="sb-sep">·</span>
          <span>{summary.sandbox || '—'}</span>
          {onReveal && (
            <button className="icon-btn" onClick={onReveal} title="在 Finder 中显示">
              ⌗
            </button>
          )}
        </span>
      ) : (
        <span className="sb-meta sb-empty">Unroll your Codex sessions</span>
      )}
    </header>
  );
}
