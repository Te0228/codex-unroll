/**
 * 顶部状态条（§6.1，28px）。
 *
 * ★ 只显示 3 个值：model · approval · sandbox（F4）。
 *   旧设计的 11 个摘要卡片区已废除——它占了最贵的空间去展示整场不变的值（F5）。
 *   provider / effort / 耗时 / token 挪到「选中会话头条目时的详情面板」（F8）。
 */
import type { SessionSummary } from '../../shared/types';

export interface StatusBarProps {
  fileName: string;
  summary: SessionSummary | null;
  onReveal?: () => void;
}

export function StatusBar({ fileName, summary, onReveal }: StatusBarProps) {
  return (
    <header className="statusbar" data-testid="statusbar">
      <span className="sb-file">{fileName || 'codex-unroll'}</span>
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
