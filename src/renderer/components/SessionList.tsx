/**
 * 左栏会话列表（§6.1，240px；F1 / F2）+ 按项目分组（§12 Q3）。
 * 每项：时间、模型、文件大小、首条用户消息（截断）。
 *
 * ★ 组头一律显示，**哪怕只有一个项目**。
 *   曾经反过来做过（单组时抑制组头，理由是「值恒定 = 噪音」），实测被推翻：
 *   组头承载的是**项目身份**，不是分组的装饰。9 个会话全在 openai/codex 的用户
 *   打开 app 后「根本不知道自己在看哪个仓库」——项目信息只剩详情面板里的 cwd。
 *   身份信息不能因为「当前只有一个值」就隐藏。
 */
import { useEffect, useMemo, useRef } from 'react';
import type { SessionListItem } from '../../shared/types';
import { basename, formatBytes, formatStamp } from '../format';
import { groupKeyOf, groupSessions, matchesSession } from '../sessionGroups';
import { useCollapsedGroups } from '../hooks/useCollapsedGroups';
import { useT } from '../i18n';

export interface SessionListProps {
  items: SessionListItem[];
  activePath: string | null;
  filter: string;
  onFilterChange: (v: string) => void;
  onOpen: (path: string) => void;
  onOpenDialog: () => void;
  onReload: () => void;
}

export function SessionList({
  items,
  activePath,
  filter,
  onFilterChange,
  onOpen,
  onOpenDialog,
  onReload,
}: SessionListProps) {
  const { t } = useT();
  const { isCollapsed, toggle, expand } = useCollapsedGroups();

  // 先过滤再分组：过滤后为空的组自然不存在，也就不会渲染出空组头
  const groups = useMemo(
    () => groupSessions(items.filter((it) => matchesSession(it, filter))),
    [items, filter],
  );

  /**
   * 打开会话时自动展开它所在的组——「用户永远看得到自己在哪」的兜底。
   *
   * ⚠️ 只在 activePath **变化**时展开，不是每次渲染都展开：
   *    否则用户在打开某个会话后就再也折不上那个组了（折完立刻被弹开）。
   *    找不到对应项时不记 ref，等会话列表加载完再补一次（拖放先于扫描完成的情况）。
   */
  const autoExpandedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activePath) return;
    if (autoExpandedRef.current === activePath) return;
    const hit = items.find((it) => it.path === activePath);
    if (!hit) return;
    autoExpandedRef.current = activePath;
    expand(groupKeyOf(hit));
  }, [activePath, items, expand]);

  const total = groups.reduce((n, g) => n + g.items.length, 0);

  const renderItem = (it: SessionListItem) => (
    <button
      key={it.path}
      type="button"
      className={`session-item${it.path === activePath ? ' active' : ''}`}
      data-testid="session-item"
      data-path={it.path}
      onClick={() => onOpen(it.path)}
    >
      <span className="session-time">
        <span>{formatStamp(it.mtime)}</span>
        <span>{formatBytes(it.size)}</span>
      </span>
      <span className="session-first">{it.firstUser || basename(it.path)}</span>
      <span className="session-model">{it.model || ''}</span>
    </button>
  );

  return (
    <nav className="sessions" data-testid="session-list" aria-label={t('ui.sessionListLabel')}>
      <div className="sessions-head">
        <h2>{t('ui.sessions')}</h2>
        <span className="spacer" />
        <button
          className="icon-btn"
          onClick={onOpenDialog}
          title={t('ui.openFileTitle')}
          aria-label={t('ui.openFile')}
        >
          📂
        </button>
        <button
          className="icon-btn"
          onClick={onReload}
          title={t('ui.reloadTitle')}
          aria-label={t('ui.reload')}
        >
          ↻
        </button>
      </div>

      <input
        className="sessions-filter"
        placeholder={t('ui.filterPlaceholder')}
        aria-label={t('ui.filterSessions')}
        value={filter}
        onChange={(e) => onFilterChange(e.target.value)}
      />

      <div className="sessions-list">
        {total === 0 && <p className="sessions-empty">{t('ui.noSessions')}</p>}

        {groups.map((g) => {
          const off = isCollapsed(g.key);
          // 组名是**数据**（owner/repo 或目录末两段），原样显示；
          // 唯一要翻译的是「认不出是哪个项目」这一种，对应 ProjectRef.labelKey
          const label = g.unknown ? t('project.unknown') : g.label;
          // 用户可以在打开会话之后再手动折叠该组——那时自动展开不生效，
          // 只能靠这个点告诉他「你正看的那条在里面」
          const hidesActive = off && g.items.some((it) => it.path === activePath);
          return (
            <section className="session-group" key={g.key} data-testid="session-group" data-key={g.key}>
              <button
                type="button"
                className="session-group-head"
                data-testid="session-group-head"
                data-key={g.key}
                aria-expanded={!off}
                // 组名会被省略号截掉，悬停给出完整身份（git:host/owner/repo 或 dir:绝对路径）
                title={g.unknown ? label : g.key}
                onClick={() => toggle(g.key)}
              >
                <span className="session-group-caret" aria-hidden="true">
                  {off ? '▸' : '▾'}
                </span>
                {hidesActive && (
                  <span
                    className="session-group-dot g-input"
                    data-testid="session-group-dot"
                    title={t('ui.currentSessionInGroup')}
                    aria-label={t('ui.currentSessionInGroup')}
                  >
                    ●
                  </span>
                )}
                <span className="session-group-label">{label}</span>
                <span className="session-group-count">{g.items.length}</span>
              </button>
              {!off && <div className="session-group-items">{g.items.map(renderItem)}</div>}
            </section>
          );
        })}
      </div>
    </nav>
  );
}
