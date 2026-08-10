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
import { useT } from '../i18n';

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
  const { t } = useT();
  const filtered = visible !== total;
  return (
    <footer className="filterbar" data-testid="filterbar">
      <span className="fb-sessions">{t('ui.sessionCount', { n: sessionCount })}</span>

      <span className="fb-total" data-testid="entry-count">
        {filtered ? t('ui.recordCountFiltered', { visible, total }) : t('ui.recordCount', { n: total })}
      </span>

      <span className="fb-groups" role="group" aria-label={t('ui.typeFilter')}>
        {GROUPS.map((g) => {
          const on = active.has(g.id);
          // 组名本身也要翻译，所以先取出来，再当参数塞进「（点击隐藏/显示）」那条
          const label = t(g.labelKey);
          return (
            <button
              key={g.id}
              className={`fb-group ${on ? 'on' : 'off'}`}
              data-testid={`group-${g.id}`}
              data-count={counts[g.id] ?? 0}
              aria-pressed={on}
              title={t(on ? 'ui.groupHide' : 'ui.groupShow', { label })}
              onClick={() => onToggleGroup(g.id)}
            >
              <span className={`g-${g.id}`} aria-hidden="true">
                {g.symbol}
              </span>
              <span>{label}</span>
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
          aria-label={t('ui.fullTextSearch')}
          placeholder={t('ui.searchPlaceholder')}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
        />
      </span>

      <button
        className={`fb-follow${following ? ' live' : ''}`}
        data-testid="follow-toggle"
        aria-pressed={following}
        disabled={!canFollow}
        title={canFollow ? t('ui.followTitle') : t('ui.followUnavailable')}
        onClick={onToggleFollow}
      >
        <span aria-hidden="true">{following ? '☑' : '☐'}</span>
        <span>{t('ui.follow')}</span>
        {following && <span aria-hidden="true">●</span>}
      </button>
    </footer>
  );
}
