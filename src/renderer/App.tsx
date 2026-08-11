/**
 * codex-unroll 的三栏外壳（SPEC §6.1）。
 *
 * 左 240px 会话列表 / 中间自适应时间线 / 右 420px 详情面板（选中才渲染）。
 * 顶部 28px 状态条只放 model · approval · sandbox，**没有摘要卡片区**（F5）。
 *
 * 解析放在渲染进程（§7.2）：主进程只给原始行，toEntries/summarize 是纯函数。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import type { DisplayGroup, Entry, SessionSummary } from '../shared/types';
import { GROUPS, kindToGroup } from '../shared/groups';
import { summarize, toEntries } from '../shared/rollout';
import { buildGraph } from '../shared/steps';
import { buildPairs } from '../shared/pairing';
import { StatusBar } from './components/StatusBar';
import { SessionList } from './components/SessionList';
import { MainPane } from './components/MainPane';
import { DetailPanel } from './components/DetailPanel';
import { FilterBar } from './components/FilterBar';
import { DropZone } from './components/DropZone';
import { useSessions } from './hooks/useSessions';
import { useSelection } from './hooks/useSelection';
import { useFollow } from './hooks/useFollow';
import { useResizable } from './hooks/useResizable';
import { useViewMode } from './hooks/useViewMode';
import { useLocalePref } from './hooks/useLocalePref';
import { LocaleProvider, useT } from './i18n';
import type { LocalePref } from '../shared/i18n';
import { basename, matchesQuery } from './format';

interface Doc {
  /** 磁盘路径；拖放进来的文件可能只有文件名 */
  path: string;
  name: string;
  /** 跟随起点（字节数，§7.4 第 1 条） */
  size: number;
  /** 有真实磁盘路径才能跟随（拖放的 File 在 sandbox 下拿不到路径） */
  live: boolean;
  entries: Entry[];
  summary: SessionSummary;
}

const ALL_GROUPS: DisplayGroup[] = GROUPS.map((g) => g.id);

/** 未打开文件时的稳定空数组，见下方 entries 处的说明 */
const NO_ENTRIES: Entry[] = [];

function emptyCounts(): Record<DisplayGroup, number> {
  return { input: 0, think: 0, act: 0, output: 0, meta: 0, error: 0 };
}

/** 从原始行构造文档。追加时复用（重新 summarize，耗时/token 会随新行更新） */
function buildDoc(path: string, lines: string[], size: number, live: boolean): Doc {
  const entries = toEntries(lines);
  return { path, name: basename(path), size, live, entries, summary: summarize(entries) };
}

/**
 * 外壳只干两件事：保管语言偏好、把 Provider 架在整棵树上面。
 *
 * ★ 为什么要多这一层组件：`useT()` 必须在 `LocaleProvider` **内部**才能读到
 *   Context，而 Provider 是 App 自己渲染的——同一个组件里既渲染 Provider
 *   又想消费它，拿到的永远是空 Context。所以真正的界面下沉到 AppShell。
 */
export function App() {
  const localePref = useLocalePref();
  return (
    <LocaleProvider pref={localePref.pref}>
      <AppShell localePref={localePref.pref} onLocalePrefChange={localePref.setPref} />
    </LocaleProvider>
  );
}

interface AppShellProps {
  localePref: LocalePref;
  onLocalePrefChange: (p: LocalePref) => void;
}

function AppShell({ localePref, onLocalePrefChange }: AppShellProps) {
  const { locale } = useT();
  const sessions = useSessions();
  const [doc, setDoc] = useState<Doc | null>(null);
  const [sessionFilter, setSessionFilter] = useState('');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<Set<DisplayGroup>>(() => new Set(ALL_GROUPS));
  const [following, setFollowing] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);

  const searchRef = useRef<HTMLInputElement | null>(null);
  const detailSearchRef = useRef<HTMLInputElement | null>(null);
  const lastSelectedRef = useRef<number | null>(null);

  // 空数组必须是稳定引用：写成 `doc?.entries ?? []` 会让每次渲染都拿到新数组，
  // 下面两个 useMemo 的依赖每次都变，等于完全没有 memo
  const entries = doc?.entries ?? NO_ENTRIES;
  const reloadSessions = sessions.reload;

  // 六组计数针对全部条目（F14），不随过滤变化
  const counts = useMemo(() => {
    const c = emptyCounts();
    for (const e of entries) c[kindToGroup(e.kind)] += 1;
    return c;
  }, [entries]);

  /**
   * ★ 搜索必须搜**当前语言下看到的字**（F7）：`title` / `preview` 是 `Text`，
   *   matchesQuery 自己会按 locale 翻成人话再比对（理由见 format.ts 的说明）。
   *   所以切语言会改变搜索结果，这是对的——搜索结果与眼睛看到的必须是同一份文本。
   */
  const visible = useMemo(
    () => entries.filter((e) => active.has(kindToGroup(e.kind)) && matchesQuery(locale, e, query)),
    [entries, active, query, locale],
  );

  /**
   * ★ 图从**全量** entries 切，不是从 visible 切（§6.8）。
   * Step 边界靠 token_count 划，而 token_count 属于「元信息」组——
   * 用户一关这一组，结构就会当场散架。过滤只决定哪些行渲染出来。
   */
  const graph = useMemo(() => buildGraph(entries), [entries]);
  const visibleIndices = useMemo(() => new Set(visible.map((e) => e.index)), [visible]);

  /** F14 的配对表，同样从**全量** entries 建——理由同上 */
  const pairs = useMemo(() => buildPairs(entries), [entries]);

  const selection = useSelection(visible);
  const panel = useResizable();
  const viewMode = useViewMode();

  /**
   * F14 互跳（§6.9.1）。**不能直接把 selection.select 递过去。**
   *
   * `useSelection` 的 `selected` 是从 `visible` 里 find 出来的，而面板的显示条件是
   * `selection.selected != null`。于是「跳到一个当前被过滤掉的对家」会变成：
   * selectedIndex 设上了 → 它不在 visible 里 → selected 是 null → **面板当场关掉**。
   * 用户看到的是「点了跳转，面板没了」。
   *
   * 真实触发路径很短：在夹具 01 上搜 `rejected` 命中索引 12（结果），
   * 但它的调用方索引 11 不含这个词 —— 点「跳到调用」就会关面板。
   *
   * 所以跳转前先把目标放出来：清掉搜索词、并确保它所属的那一组是开着的。
   * 这是**可见的**副作用（搜索框空了），比静默关闭面板好解释得多。
   */
  const jumpTo = useCallback(
    (index: number) => {
      const target = entries.find((e) => e.index === index);
      if (!target) return;
      if (!visibleIndices.has(index)) {
        setQuery('');
        setActive((cur) => {
          const g = kindToGroup(target.kind);
          if (cur.has(g)) return cur; // 引用不变 → 不多一次渲染
          const next = new Set(cur);
          next.add(g);
          return next;
        });
      }
      selection.select(index);
    },
    [entries, visibleIndices, selection],
  );

  // ── 打开 ────────────────────────────────────────────────────────────
  const openPath = useCallback(
    async (path: string) => {
      const api = window.unroll;
      if (!api?.readSession) return;
      const r = await api.readSession(path);
      setDoc(buildDoc(r.path ?? path, r.lines ?? [], r.size ?? 0, true));
      selection.clear();
      setQuery('');
    },
    [selection],
  );

  /**
   * 拖放打开（F12/F24）。
   * ⚠️ Electron 32 起 File.path 已移除，sandbox 下也拿不到路径，
   *    所以这里直接读 File 内容——渲染进程本来就负责解析，不需要绕回主进程。
   *    代价是没有磁盘路径就不能跟随，UI 上把「跟随」置灰说明原因。
   */
  const openDroppedFile = useCallback(
    async (file: File) => {
      const text = await file.text();
      const lines = text.split('\n').filter((l) => l.trim() !== '');
      const path = (file as File & { path?: string }).path || file.name;
      setDoc(buildDoc(path, lines, text.length, Boolean((file as File & { path?: string }).path)));
      selection.clear();
      setQuery('');
    },
    [selection],
  );

  const openDialog = useCallback(async () => {
    const api = window.unroll;
    if (!api?.openFileDialog) return;
    const p = await api.openFileDialog();
    if (p) await openPath(p);
  }, [openPath]);

  // ── 实时跟随（M5 渲染侧）────────────────────────────────────────────
  const onAppend = useCallback((lines: string[]) => {
    setDoc((d) => {
      if (!d) return d;
      const added = toEntries(lines).map((e, i) => ({ ...e, index: d.entries.length + i }));
      if (added.length === 0) return d;
      // 追加而不是重建：已有 Entry 对象引用不变，配合 TimelineRow 的 memo
      // 让已渲染的行不重渲染（G1）
      const next = [...d.entries, ...added];
      return { ...d, entries: next, summary: summarize(next) };
    });
  }, []);

  // G6：文件被截断/重建 → 重读全量。用 ref 读当前文档，
  // 不在 setState 的 updater 里做副作用（StrictMode 下 updater 会被调用两次）
  const docRef = useRef<Doc | null>(null);
  docRef.current = doc;

  const onReset = useCallback(() => {
    const d = docRef.current;
    if (d?.live) void openPath(d.path);
  }, [openPath]);

  useFollow({
    enabled: following,
    path: doc?.live ? doc.path : null,
    offset: doc?.size ?? 0,
    onAppend,
    onReset,
  });

  useEffect(() => {
    if (!doc?.live) setFollowing(false);
  }, [doc?.live, doc?.path]);

  // ── 快捷键（§6.5）──────────────────────────────────────────────────
  const toggleRight = useCallback(() => {
    if (selection.selectedIndex != null && !rightCollapsed) {
      lastSelectedRef.current = selection.selectedIndex;
      setRightCollapsed(true);
    } else if (rightCollapsed) {
      setRightCollapsed(false);
    } else if (lastSelectedRef.current != null) {
      selection.select(lastSelectedRef.current);
    }
  }, [rightCollapsed, selection]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        void openDialog();
        return;
      }
      if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        detailSearchRef.current?.focus();
        return;
      }
      if (mod && (e.key === '1' || e.key === '2')) {
        e.preventDefault();
        if (e.key === '1') setLeftCollapsed((v) => !v);
        else toggleRight();
        return;
      }
      if (e.key === 'Escape') {
        // 先退出输入框，再关面板——正在打字时按 Esc 的预期是「退出搜索」
        if (typing) {
          (target as HTMLInputElement).blur();
          return;
        }
        if (selection.selectedIndex != null) selection.clear();
        return;
      }
      if (typing || mod) return;

      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        selection.move(1);
        return;
      }
      if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        selection.move(-1);
        return;
      }
      if (e.key === 'g') {
        // 图 ⇄ 列表（§6.8）。用 g 而不是 ⌘ 组合：⌘1/⌘2 已经是折叠左右栏了
        viewMode.toggle();
        return;
      }
      if (e.key === 'r') {
        reloadSessions();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openDialog, selection, reloadSessions, toggleRight, viewMode]);

  // ── 拖放（窗口任意位置，F24）───────────────────────────────────────
  const onDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);
  const onDragLeave = useCallback((e: DragEvent) => {
    if (e.currentTarget === e.target) setDragOver(false);
  }, []);
  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer?.files?.[0];
      if (file) void openDroppedFile(file);
    },
    [openDroppedFile],
  );

  const toggleGroup = useCallback((g: DisplayGroup) => {
    setActive((cur) => {
      const next = new Set(cur);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });
  }, []);

  const showPanel = selection.selected != null && !rightCollapsed;
  const bodyClass = [
    'shell-body',
    showPanel ? 'has-panel' : '',
    leftCollapsed ? 'no-left' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="shell" onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <StatusBar
        fileName={doc?.name ?? ''}
        summary={doc?.summary ?? null}
        localePref={localePref}
        onLocalePrefChange={onLocalePrefChange}
        onReveal={
          doc?.live
            ? () => {
                void window.unroll?.revealInFinder?.(doc.path);
              }
            : undefined
        }
      />

      <div className={bodyClass} data-testid="shell-body">
        {!leftCollapsed && (
          <SessionList
            items={sessions.items}
            activePath={doc?.path ?? null}
            filter={sessionFilter}
            onFilterChange={setSessionFilter}
            onOpen={(p) => void openPath(p)}
            onOpenDialog={() => void openDialog()}
            onReload={sessions.reload}
          />
        )}

        {doc ? (
          <MainPane
            view={viewMode.view}
            onViewChange={viewMode.setView}
            graph={graph}
            total={entries.length}
            visible={visible}
            visibleIndices={visibleIndices}
            selectedIndex={selection.selectedIndex}
            onSelect={selection.toggle}
          />
        ) : (
          <DropZone
            sessionsDir={sessions.sessionsDir}
            dragOver={dragOver}
            onOpenDialog={() => void openDialog()}
          />
        )}

        {showPanel && selection.selected && (
          <DetailPanel
            key={selection.selected.index}
            entry={selection.selected}
            summary={doc?.summary ?? null}
            onClose={selection.clear}
            onResizeStart={panel.onPointerDown}
            searchRef={detailSearchRef}
            pairs={pairs}
            onJump={jumpTo}
          />
        )}
      </div>

      <FilterBar
        sessionCount={sessions.items.length}
        total={entries.length}
        visible={visible.length}
        counts={counts}
        active={active}
        onToggleGroup={toggleGroup}
        query={query}
        onQueryChange={setQuery}
        searchRef={searchRef}
        following={following}
        canFollow={Boolean(doc?.live)}
        onToggleFollow={() => setFollowing((v) => !v)}
      />
    </div>
  );
}
