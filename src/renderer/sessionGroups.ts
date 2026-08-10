/**
 * 左栏会话按项目分组（SPEC §12 Q3）。纯函数，与 React 无关，直接单测。
 *
 * ★ 组为什么按「组内最新活动」倒序，而不是项目名字母序：
 *   分组最大的副作用是让「我最近在干什么」变难找——按名字排的话，
 *   刚写完的那条可能落在第三组里。按组内最新 mtime 倒序后，
 *   **第一组的第一条永远是全局最新的会话**，「最近」和「按项目找」同时成立。
 *   这条不要改。
 *
 * ★ 「未知项目」永远垫底，不参与活跃度排序：
 *   project 是主进程扫描时补的，一旦某次扫描漏了元数据，
 *   这些项会带着很新的 mtime 霸占第一组——那恰好毁掉上面那条性质。
 */
import type { SessionListItem } from '../shared/types';
import type { MsgKey } from '../shared/i18n';
import { UNKNOWN_PROJECT } from '../shared/project';

/** 未知项目组的键。用非空值，避免空字符串当 React key / localStorage 成员时的歧义；
 *  真实项目键一律是 `git:` / `dir:` 前缀，不会撞上。 */
export const UNKNOWN_KEY = 'unknown:';

export interface SessionGroup {
  key: string;
  /**
   * 组头文案。**放的是数据**（`owner/repo` 或目录末两段），任何语言下原样显示。
   * 未知项目组这里是空串，文案走 `labelKey`——见 SPEC §15.1。
   */
  label: string;
  /** 有值时用它翻译出组头，`label` 作废。目前只有「未知项目」这一种情况。 */
  labelKey?: MsgKey;
  kind: 'git' | 'dir' | 'unknown';
  /** 组内按 mtime 倒序 */
  items: SessionListItem[];
  /** 组内最新 mtime，组间排序用 */
  latest: number;
  /** 元数据缺失的兜底组，永远排最后 */
  unknown: boolean;
}

/** 会话归属的组键。groupSessions 与「自动展开」共用，避免两处各写一套未知判定 */
export function groupKeyOf(item: SessionListItem): string {
  return item.project?.key || UNKNOWN_KEY;
}

/**
 * 过滤单个会话。除原有的 path / model / cwd / firstUser 外，
 * **项目名与项目键也参与匹配**——搜 `codex` 要能把该项目下的会话全捞出来，
 * 哪怕这些会话的文件名和首条消息里根本没有 codex。
 */
export function matchesSession(item: SessionListItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [item.path, item.model, item.cwd, item.firstUser, item.project?.label, item.project?.key]
    .filter(Boolean)
    .some((s) => String(s).toLowerCase().includes(q));
}

/**
 * 按项目聚合。组内按 mtime 倒序，组间按组内最新 mtime 倒序，未知项目组垫底。
 * 空输入返回空数组（调用方据此显示「没有会话」）。
 */
export function groupSessions(items: SessionListItem[]): SessionGroup[] {
  const byKey = new Map<string, SessionGroup>();

  for (const it of items) {
    // 注意 project 可能存在但 key 为空（UNKNOWN_PROJECT），同样算未知
    const p = it.project;
    const unknown = !p || !p.key;
    const key = groupKeyOf(it);
    let g = byKey.get(key);
    if (!g) {
      // ★ 未知组的文案不在这里定：`UNKNOWN_PROJECT.label` 现在是空串，
      //   「未知项目」四个字是 `labelKey` 指向的目录项，渲染层才翻。
      //   此前这行拿 `UNKNOWN_PROJECT.label` 兜底，本地化之后会兜出一个空白组头。
      g = {
        key,
        label: unknown ? '' : p.label,
        ...(unknown || !p.label ? { labelKey: UNKNOWN_PROJECT.labelKey } : {}),
        kind: unknown ? 'unknown' : p.kind,
        items: [],
        latest: Number.NEGATIVE_INFINITY,
        unknown,
      };
      byKey.set(key, g);
    }
    g.items.push(it);
    if (it.mtime > g.latest) g.latest = it.mtime;
  }

  const groups = [...byKey.values()];
  for (const g of groups) g.items.sort((a, b) => b.mtime - a.mtime);
  groups.sort((a, b) => {
    if (a.unknown !== b.unknown) return a.unknown ? 1 : -1;
    if (b.latest !== a.latest) return b.latest - a.latest;
    // mtime 完全相同时按 label 定序，保证渲染顺序稳定
    return a.label.localeCompare(b.label);
  });
  return groups;
}
