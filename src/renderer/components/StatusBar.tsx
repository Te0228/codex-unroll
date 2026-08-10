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
 *
 * ★ 最右边挂语言切换（§15）。
 *   这个 app 没有设置面板，也不值得为一个三选一的开关做一个——
 *   状态条是唯一一处「全局的、永远在的」界面，语言正好属于那一类。
 */
import type { SessionSummary } from '../../shared/types';
import { projectRef } from '../../shared/project';
import { asLocalePref, LOCALES, LOCALE_NAME, type LocalePref } from '../../shared/i18n';
import { useT } from '../i18n';

export interface StatusBarProps {
  fileName: string;
  summary: SessionSummary | null;
  localePref: LocalePref;
  onLocalePrefChange: (p: LocalePref) => void;
  onReveal?: () => void;
}

/** 图标只表身份类型，形状独立于颜色（灰度下也能区分，同 F21） */
const KIND_ICON = { git: '⎇', dir: '▤', unknown: '·' } as const;

export function StatusBar({
  fileName,
  summary,
  localePref,
  onLocalePrefChange,
  onReveal,
}: StatusBarProps) {
  const { t } = useT();

  // cwd / repositoryUrl 都缺时 projectRef 返回 UNKNOWN_PROJECT，
  // 显示「未知项目」而不是 undefined
  const project = summary ? projectRef(summary.cwd, summary.repositoryUrl) : null;
  // 认不出项目时 label 是空串、真正的文案在 labelKey 上（见 shared/project.ts）
  const projectLabel = project ? (project.labelKey ? t(project.labelKey) : project.label) : '';
  const projectTitle = summary
    ? [summary.cwd, summary.repositoryUrl].filter(Boolean).join('\n') || projectLabel
    : '';

  return (
    <header className="statusbar" data-testid="statusbar">
      <span className="sb-file">{fileName || 'codex-unroll'}</span>

      {project && (
        <span className="sb-project" data-testid="statusbar-project" title={projectTitle}>
          <span className="sb-project-icon" aria-hidden="true">
            {KIND_ICON[project.kind]}
          </span>
          <span className="sb-project-label">{projectLabel}</span>
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
            <button className="icon-btn" onClick={onReveal} title={t('ui.revealInFinder')}>
              ⌗
            </button>
          )}
        </span>
      ) : (
        <span className="sb-meta sb-empty">Unroll your Codex sessions</span>
      )}

      {/*
       * 语言切换（§15）。
       * ★ 语言名永远写它**自己的语言**：正在看英文界面的人要找的是「中文」，
       *   把它翻译成 "Chinese" 反而让目标用户认不出来。所以这里用 LOCALE_NAME，
       *   只有「跟随系统」这一项是当前语言的词——它描述的是行为，不是语言。
       * ★ 用原生 <select> 而不是自绘下拉：三个选项、一个全局开关，
       *   自绘要补键盘导航和焦点管理，收益为零。
       */}
      <select
        className="sb-locale"
        data-testid="locale-select"
        aria-label={t('ui.language')}
        title={t('ui.language')}
        value={localePref}
        onChange={(e) => onLocalePrefChange(asLocalePref(e.target.value))}
      >
        <option value="system">{t('ui.languageSystem')}</option>
        {LOCALES.map((l) => (
          <option key={l} value={l}>
            {LOCALE_NAME[l]}
          </option>
        ))}
      </select>
    </header>
  );
}
