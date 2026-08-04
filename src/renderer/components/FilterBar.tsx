/**
 * 底部状态栏（§6.1，26px）：6 组过滤 + 各组计数 + 全文搜索 + 跟随开关。
 *
 * 分组与符号来自 shared/groups.ts（GROUPS 的顺序即显示顺序，F14）。
 * 色值只走 CSS class（g-input …），CSP 下不能用行内 style。
 * 计数针对**全部条目**，不随过滤变化——否则关掉一组后它自己的计数会变成 0，
 * 用户就没法再判断该不该打开它。
 */
import type { RefObject } from 'react';
import type { DisplayGroup } from '../../shared/types';
import { GROUPS } from '../../shared/groups';

export interface FilterBarProps {
  sessionCount: number;
  total: number;
  visible: number;
  counts: Record<DisplayGroup, number>;
  active: Set<DisplayGroup>;
  onToggleGroup: (g: DisplayGroup) => void;
  query: string;
  onQueryChange: (v: string) => void;
  searchRef?: RefObject<HTMLInputElement | null>;
  following: boolean;
  canFollow: boolean;
  onToggleFollow: () => void;
}

export function FilterBar({
  sessionCount,
  total,
  visible,
  counts,
  active,
  onToggleGroup,
  query,
  onQueryChange,
  searchRef,
  following,
  canFollow,
  onToggleFollow,
}: FilterBarProps) {
  const filtered = visible !== total;
  return (
    <footer className="filterbar" data-testid="filterbar">
      <span className="fb-sessions">{sessionCount} 个会话</span>

      <span className="fb-total" data-testid="entry-count">
        {filtered ? `${visible} / ${total} 条` : `${total} 条`}
      </span>

      <span className="fb-groups" role="group" aria-label="类型过滤">
        {GROUPS.map((g) => {
          const on = active.has(g.id);
          return (
            <button
              key={g.id}
              className={`fb-group ${on ? 'on' : 'off'}`}
              data-testid={`group-${g.id}`}
              data-count={counts[g.id] ?? 0}
              aria-pressed={on}
              title={`${g.label}（点击${on ? '隐藏' : '显示'}）`}
              onClick={() => onToggleGroup(g.id)}
            >
              <span className={`g-${g.id}`} aria-hidden="true">
                {g.symbol}
              </span>
              <span>{g.label}</span>
              <span>{counts[g.id] ?? 0}</span>
            </button>
          );
        })}
      </span>

      <span className="fb-search">
        <span aria-hidden="true">🔍</span>
        <input
          ref={searchRef}
          data-testid="search"
          aria-label="全文搜索"
          placeholder="搜索  /"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
        />
      </span>

      <button
        className={`fb-follow${following ? ' live' : ''}`}
        data-testid="follow-toggle"
        aria-pressed={following}
        disabled={!canFollow}
        title={canFollow ? '实时跟随文件末尾' : '拖放打开的文件没有磁盘路径，无法跟随'}
        onClick={onToggleFollow}
      >
        <span aria-hidden="true">{following ? '☑' : '☐'}</span>
        <span>跟随</span>
        {following && <span aria-hidden="true">●</span>}
      </button>
    </footer>
  );
}
