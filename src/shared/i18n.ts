/**
 * 本地化（SPEC §15）。
 *
 * ── 为什么归一化层不能直接出人话 ──────────────────────────────────
 * `classify()` 原本把 `title: '用户'` 这样的中文烤进 `Entry`。问题是 `Entry`
 * 由 **shared 层**产出、被 main 与 renderer 共用，而语言是**渲染时**才知道的
 * 用户偏好——一旦烤进去，切语言就得把整个会话重新归一化一遍。
 *
 * 所以这里的规矩是：**数据层出 `MsgRef`（key + 参数），渲染层出字符串。**
 * 纯数据（工具名、模型名、命令输出）保持原样是 `string`，两者合起来叫 `Text`：
 *
 *     type Text = string | MsgRef
 *     resolve(locale, text) → string
 *
 * `Entry.title` 与 `Entry.preview` 都是 `Text`。这意味着「工具调用」的标题是
 * `{ key: 'entry.toolCall', params: { tool: 'exec_command' } }` 而不是
 * 拼好的 `'→ exec_command'`——箭头属于排版，不属于数据。
 *
 * ── 两个目录的 key 集合必须完全一致 ──────────────────────────────
 * `ZH` 被显式标注成 `Record<keyof typeof EN, Msg>`，**少一个 key 就编译不过**。
 * 运行时还有一条单测兜底（防止有人用 `as` 绕过去）。
 * 缺 key 的兜底是「回退英文 → 再回退 key 本身」，绝不抛异常也绝不显示空白：
 * 查看器的职责是把东西摊开，界面上出现空字符串比出现英文原文更糟。
 *
 * ── 语言怎么定 ───────────────────────────────────────────────────
 * 偏好存 localStorage（`'system' | 'en' | 'zh-CN'`），默认 `'system'`，
 * `'system'` 再按 `navigator.language` 解析。**不走 IPC**——`preload` 严格
 * 只暴露 8 个方法（§7.3 / 验收 E7），为了语言去动那个契约不值得。
 * 主进程自己那两条文案（打开文件对话框）用 Electron 的 `app.getLocale()`。
 */

// ─────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────

export const LOCALES = ['en', 'zh-CN'] as const;
export type Locale = (typeof LOCALES)[number];

/** 用户偏好。`system` 表示跟随系统，不是一种语言。 */
export type LocalePref = 'system' | Locale;

/**
 * ★ 默认英文。
 *
 * 这是**兜底值**，不是「大多数用户会看到的东西」——正常路径永远先问
 * `navigator.language`。选英文当兜底是因为兜底触发的场景（读不到语言、
 * 取到一个谁也没见过的 tag）里，英文是更安全的最小公分母。
 */
export const DEFAULT_LOCALE: Locale = 'en';

export type MsgParams = Record<string, string | number>;
type Msg = string | ((p: MsgParams) => string);

/** 待翻译的文本：一个 key 加可选参数。 */
export interface MsgRef {
  key: MsgKey;
  params?: MsgParams;
}

/** 要么是已经确定的数据（工具名、命令输出），要么是待翻译的 key。 */
export type Text = string | MsgRef;

export function isMsgRef(t: Text): t is MsgRef {
  return typeof t === 'object' && t !== null && 'key' in t;
}

/** 构造 `MsgRef` 的简写。参数为空时不塞 `params` 字段，方便测试里直接比对。 */
export function ref(key: MsgKey, params?: MsgParams): MsgRef {
  return params === undefined ? { key } : { key, params };
}

// ─────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────

/** 拼接非空片段，与 rollout.ts 的 joinParts 同一口径（空片段整个丢掉）。 */
const join = (parts: (string | number | undefined | null)[], sep = ' · '): string =>
  parts
    .map((p) => (p === undefined || p === null ? '' : String(p)))
    .filter((s) => s !== '')
    .join(sep);

// ─────────────────────────────────────────────────────────────
// 英文目录 —— key 集合的**唯一事实来源**
// ─────────────────────────────────────────────────────────────

const EN = {
  // ── Entry 标题（shared/rollout.ts 的 classify） ──────────────
  'entry.user': 'User',
  'entry.assistant': 'Model',
  'entry.developer': 'Developer',
  'entry.system': 'System',
  'entry.reasoning': 'Reasoning',
  'entry.taskStarted': 'Task started',
  'entry.taskComplete': 'Done',
  'entry.usage': 'Usage',
  'entry.error': 'Error',
  'entry.sessionStart': 'Session start',
  'entry.turnContext': 'Turn config',
  'entry.worldState': 'World state',
  'entry.toolCall': (p: MsgParams) => `→ ${p.tool}`,
  /**
   * 工具名缺失时用这条，而不是往 `entry.toolCall` 里塞一个翻译好的兜底词——
   * 目录函数拿不到 `translate`，参数里的东西没法再翻一次。
   */
  'entry.toolCallUnnamed': '→ tool',
  'entry.toolOut': '← Result',
  'entry.parseError': 'Parse error',
  'entry.parseErrorAt': (p: MsgParams) => `Parse error (line ${p.lineno})`,
  'entry.unknown': 'Unknown',

  // ── Entry 正文里含固定文案的两处 ────────────────────────────
  'preview.taskComplete': (p: MsgParams) =>
    join([
      p.duration === undefined ? '' : `${p.duration}ms`,
      p.ttft === undefined ? '' : `first token ${p.ttft}ms`,
      p.message,
    ]),
  'preview.tokenCount': (p: MsgParams) =>
    join([
      p.input === undefined ? '' : `in ${p.input}`,
      p.output === undefined ? '' : `out ${p.output}`,
    ]),

  // ── 12 个数据层分类（renderer/format.ts） ───────────────────
  'kind.session': 'Session',
  'kind.context': 'Turn',
  'kind.user': 'User',
  'kind.assistant': 'Model',
  'kind.reasoning': 'Reason',
  'kind.tool_call': 'Tool',
  'kind.tool_out': 'Result',
  'kind.lifecycle': 'Cycle',
  'kind.usage': 'Usage',
  'kind.state': 'State',
  'kind.error': 'Error',
  'kind.other': 'Other',

  // ── 6 个显示分组（shared/groups.ts） ────────────────────────
  'group.input': 'Input',
  'group.think': 'Thinking',
  'group.act': 'Action',
  'group.output': 'Output',
  'group.meta': 'Meta',
  'group.error': 'Error',

  // ── Step 收场（renderer/components/StepGraph.tsx） ──────────
  'outcome.act': 'calls a tool',
  'outcome.answer': 'done',
  'outcome.open': 'unfinished',

  // ── 项目身份（shared/project.ts） ───────────────────────────
  'project.unknown': 'Unknown project',

  // ── 会话列表 ────────────────────────────────────────────────
  'ui.sessionListLabel': 'Session list',
  'ui.sessions': 'Sessions',
  'ui.openFile': 'Open file',
  'ui.openFileTitle': 'Open file ⌘O',
  'ui.reload': 'Reload',
  'ui.reloadTitle': 'Reload r',
  'ui.filterPlaceholder': 'Filter…',
  'ui.filterSessions': 'Filter sessions',
  'ui.noSessions': 'No sessions',
  'ui.currentSessionInGroup': 'The session you have open is in this group',

  // ── 空状态 / 拖放区 ─────────────────────────────────────────
  'ui.dropTitle': 'Drop a rollout .jsonl here',
  'ui.orPickLeft': 'or pick one on the left, or press',
  'ui.openShortcut': '⌘O to open',
  'ui.scanDir': (p: MsgParams) => `Scanning: ${p.dir}`,

  // ── 底部状态栏 / 过滤条 ─────────────────────────────────────
  'ui.sessionCount': (p: MsgParams) => (p.n === 1 ? '1 session' : `${p.n} sessions`),
  'ui.recordCount': (p: MsgParams) => (p.n === 1 ? '1 record' : `${p.n} records`),
  'ui.recordCountFiltered': (p: MsgParams) => `${p.visible} / ${p.total} records`,
  'ui.typeFilter': 'Type filter',
  'ui.groupHide': (p: MsgParams) => `${p.label} (click to hide)`,
  'ui.groupShow': (p: MsgParams) => `${p.label} (click to show)`,
  'ui.fullTextSearch': 'Full-text search',
  'ui.searchPlaceholder': 'Search  /',
  'ui.follow': 'Follow',
  'ui.followTitle': 'Follow the end of the file live',
  'ui.followUnavailable': 'A dropped file has no path on disk, so it cannot be followed',
  'ui.revealInFinder': 'Reveal in Finder',

  // ── 主区视图切换 ────────────────────────────────────────────
  'ui.mainView': 'Main view',
  'ui.viewGraph': 'Graph',
  'ui.viewList': 'List',
  'ui.timeline': 'Timeline',
  'ui.noMatchingEntries': 'No matching entries',
  'ui.nothingToShow': 'Nothing to show',

  // ── 图视图 ──────────────────────────────────────────────────
  'ui.turnNo': (p: MsgParams) => `Turn ${p.no}`,
  'ui.stepNo': (p: MsgParams) => `Step ${p.no}`,
  'ui.stepCount': (p: MsgParams) => (p.n === 1 ? '1 step' : `${p.n} steps`),
  'ui.stepLinkAct': 'tool result goes back into history, ask the model again',
  'ui.stepLinkContinue': 'continue',
  'ui.turnNoOutput': 'no model output in this turn',
  'ui.stepNoOutput': 'no visible output in this step',
  'ui.filteredOut': (p: MsgParams) => `${p.n} filtered out`,
  'ui.ttft': (p: MsgParams) => `first token ${p.value}`,
  'ui.turnOpen': 'in progress · no task_complete yet',
  'ui.expandContext': (p: MsgParams) => `show ${p.n} context records`,
  'ui.collapseContext': (p: MsgParams) => `hide ${p.n} context records`,

  // ── 详情面板 ────────────────────────────────────────────────
  'ui.detail': 'Details',
  'ui.closeDetail': 'Close detail panel',
  'ui.searchInEntry': 'Search within this entry',
  'ui.searchInEntryPlaceholder': 'Search this entry ⌘F',
  'ui.hits': (p: MsgParams) => (p.n === 1 ? '1 hit' : `${p.n} hits`),
  'ui.type': 'Type',
  'ui.time': 'Time',
  'ui.duration': 'Duration',
  'ui.ttftParen': (p: MsgParams) => `(first token ${p.value})`,
  'ui.noBody': '(No body — expand the raw JSON below)',
  'ui.bodyChars': (p: MsgParams) => `Body: ${p.n} chars`,
  'ui.truncatedTo': (p: MsgParams) => `, truncated to ${p.n}`,
  'ui.expandAll': 'Show all',
  'ui.collapse': 'Collapse',

  // ── 原始 JSON ───────────────────────────────────────────────
  'ui.rawJson': 'Raw JSON',
  'ui.rawJsonTree': 'Raw JSON tree',
  'ui.rawJsonViews': 'Raw JSON view',
  'ui.rawJsonSearchNote': 'Search does not cover raw JSON, and values collapsed in the tree stay hidden',
  'ui.viewInText': 'View it in the text view',
  'ui.viewTree': 'Tree',
  'ui.viewText': 'Text',
  'ui.expandEverything': 'Expand all',
  'ui.collapseEverything': 'Collapse all',
  'ui.jsonExpand': 'Expand',
  'ui.jsonCollapse': 'Collapse',

  // ── 语言设置 ────────────────────────────────────────────────
  'ui.language': 'Language',
  'ui.languageSystem': 'System',

  // ── 主进程（打开文件对话框） ────────────────────────────────
  'ui.openRollout': 'Open rollout',
  'ui.allFiles': 'All files',
} as const;

export type MsgKey = keyof typeof EN;

// ─────────────────────────────────────────────────────────────
// 中文目录 —— 类型标注保证 key 集合与 EN 完全一致
// ─────────────────────────────────────────────────────────────

const ZH: Record<MsgKey, Msg> = {
  'entry.user': '用户',
  'entry.assistant': '模型',
  'entry.developer': '开发者',
  'entry.system': '系统',
  'entry.reasoning': '推理',
  'entry.taskStarted': '任务开始',
  'entry.taskComplete': '完成',
  'entry.usage': '用量',
  'entry.error': '错误',
  'entry.sessionStart': '会话开始',
  'entry.turnContext': '轮次配置',
  'entry.worldState': '世界状态',
  'entry.toolCall': (p) => `→ ${p.tool}`,
  'entry.toolCallUnnamed': '→ 工具',
  'entry.toolOut': '← 结果',
  'entry.parseError': '解析失败',
  'entry.parseErrorAt': (p) => `解析失败（第 ${p.lineno} 行）`,
  'entry.unknown': '未知',

  'preview.taskComplete': (p) =>
    join([
      p.duration === undefined ? '' : `${p.duration}ms`,
      p.ttft === undefined ? '' : `首字 ${p.ttft}ms`,
      p.message,
    ]),
  'preview.tokenCount': (p) =>
    join([
      p.input === undefined ? '' : `输入 ${p.input}`,
      p.output === undefined ? '' : `输出 ${p.output}`,
    ]),

  'kind.session': '会话',
  'kind.context': '轮次',
  'kind.user': '用户',
  'kind.assistant': '模型',
  'kind.reasoning': '推理',
  'kind.tool_call': '工具',
  'kind.tool_out': '结果',
  'kind.lifecycle': '周期',
  'kind.usage': '用量',
  'kind.state': '状态',
  'kind.error': '异常',
  'kind.other': '其它',

  'group.input': '输入',
  'group.think': '思考',
  'group.act': '行动',
  'group.output': '输出',
  'group.meta': '元信息',
  'group.error': '异常',

  'outcome.act': '调用工具',
  'outcome.answer': '收工',
  'outcome.open': '未收尾',

  'project.unknown': '未知项目',

  'ui.sessionListLabel': '会话列表',
  'ui.sessions': '会话',
  'ui.openFile': '打开文件',
  'ui.openFileTitle': '打开文件 ⌘O',
  'ui.reload': '刷新',
  'ui.reloadTitle': '刷新 r',
  'ui.filterPlaceholder': '过滤…',
  'ui.filterSessions': '过滤会话',
  'ui.noSessions': '没有会话',
  'ui.currentSessionInGroup': '当前打开的会话在这个组里',

  'ui.dropTitle': '把 rollout .jsonl 拖到这里',
  'ui.orPickLeft': '或从左侧选择，或按',
  'ui.openShortcut': '⌘O 打开',
  'ui.scanDir': (p) => `扫描目录：${p.dir}`,

  'ui.sessionCount': (p) => `${p.n} 个会话`,
  'ui.recordCount': (p) => `${p.n} 条`,
  'ui.recordCountFiltered': (p) => `${p.visible} / ${p.total} 条`,
  'ui.typeFilter': '类型过滤',
  'ui.groupHide': (p) => `${p.label}（点击隐藏）`,
  'ui.groupShow': (p) => `${p.label}（点击显示）`,
  'ui.fullTextSearch': '全文搜索',
  'ui.searchPlaceholder': '搜索  /',
  'ui.follow': '跟随',
  'ui.followTitle': '实时跟随文件末尾',
  'ui.followUnavailable': '拖放打开的文件没有磁盘路径，无法跟随',
  'ui.revealInFinder': '在 Finder 中显示',

  'ui.mainView': '主区视图',
  'ui.viewGraph': '图',
  'ui.viewList': '列表',
  'ui.timeline': '时间线',
  'ui.noMatchingEntries': '没有匹配的条目',
  'ui.nothingToShow': '没有可展示的条目',

  'ui.turnNo': (p) => `Turn ${p.no}`,
  'ui.stepNo': (p) => `Step ${p.no}`,
  'ui.stepCount': (p) => `${p.n} step`,
  'ui.stepLinkAct': '工具结果写回历史，再问一次模型',
  'ui.stepLinkContinue': '继续',
  'ui.turnNoOutput': '这一轮没有模型产出',
  'ui.stepNoOutput': '这一步没有可见产出',
  'ui.filteredOut': (p) => `${p.n} 条被过滤`,
  'ui.ttft': (p) => `首字 ${p.value}`,
  'ui.turnOpen': '进行中 · 未见 task_complete',
  'ui.expandContext': (p) => `展开上下文 ${p.n} 条`,
  'ui.collapseContext': (p) => `收起上下文 ${p.n} 条`,

  'ui.detail': '详情',
  'ui.closeDetail': '关闭详情面板',
  'ui.searchInEntry': '在详情面板内搜索',
  'ui.searchInEntryPlaceholder': '在本条内搜索 ⌘F',
  'ui.hits': (p) => `${p.n} 处`,
  'ui.type': '类型',
  'ui.time': '时间',
  'ui.duration': '耗时',
  'ui.ttftParen': (p) => `（首 token ${p.value}）`,
  'ui.noBody': '（本条无正文，展开下方原始 JSON 查看）',
  'ui.bodyChars': (p) => `正文 ${p.n} 字符`,
  'ui.truncatedTo': (p) => `，已截断至 ${p.n}`,
  'ui.expandAll': '展开全部',
  'ui.collapse': '收起',

  'ui.rawJson': '原始 JSON',
  'ui.rawJsonTree': '原始 JSON 树',
  'ui.rawJsonViews': '原始 JSON 视图',
  'ui.rawJsonSearchNote': '搜索不覆盖原始 JSON，树里折叠的值也看不到',
  'ui.viewInText': '在原文视图中查看',
  'ui.viewTree': '树',
  'ui.viewText': '原文',
  'ui.expandEverything': '全部展开',
  'ui.collapseEverything': '全部折叠',
  'ui.jsonExpand': '展开',
  'ui.jsonCollapse': '折叠',

  'ui.language': '语言',
  'ui.languageSystem': '跟随系统',

  'ui.openRollout': '打开 rollout',
  'ui.allFiles': '所有文件',
};

export const CATALOG: Record<Locale, Record<MsgKey, Msg>> = {
  en: EN,
  'zh-CN': ZH,
};

/** 语言在**自己的语言里**怎么写。切换器永远显示这个，不翻译。 */
export const LOCALE_NAME: Record<Locale, string> = {
  en: 'English',
  'zh-CN': '中文',
};

// ─────────────────────────────────────────────────────────────
// 取词
// ─────────────────────────────────────────────────────────────

/**
 * 取一条文案。**永不抛异常、永不返回空串**：
 * 缺 key 先回退英文目录，英文也没有就把 key 本身显出来——
 * 界面上出现 `ui.someKey` 很丑，但至少能一眼看出是漏了翻译；
 * 出现空白则是查看器最不该有的东西（§6.0：摊开，不是隐藏）。
 */
export function translate(locale: Locale, key: MsgKey, params?: MsgParams): string {
  const msg = CATALOG[locale]?.[key] ?? EN[key];
  if (msg === undefined) return key;
  try {
    return typeof msg === 'function' ? msg(params ?? {}) : msg;
  } catch {
    return key;
  }
}

/** `Text` → 字符串。纯数据原样返回，`MsgRef` 走 `translate`。 */
export function resolve(locale: Locale, text: Text): string {
  return isMsgRef(text) ? translate(locale, text.key, text.params) : text;
}

// ─────────────────────────────────────────────────────────────
// 语言判定
// ─────────────────────────────────────────────────────────────

/**
 * BCP-47 标签 → 支持的语言。
 *
 * 只看主语言子标签：`zh`、`zh-CN`、`zh-Hans-CN`、`zh-TW` 全部落到 `zh-CN`。
 * ⚠️ 繁体也落到简体目录，因为**目前只有简体一份**——给繁体用户看简体，
 * 好过给他们看英文。真要分繁简是另一份目录的事，不是这个函数的事。
 */
export function localeFromLanguage(language: string | undefined): Locale {
  const tag = (language ?? '').trim().toLowerCase();
  if (tag.startsWith('zh')) return 'zh-CN';
  if (tag.startsWith('en')) return 'en';
  return DEFAULT_LOCALE;
}

/** 偏好 + 系统语言 → 实际使用的语言。 */
export function resolveLocale(pref: LocalePref, systemLanguage: string | undefined): Locale {
  return pref === 'system' ? localeFromLanguage(systemLanguage) : pref;
}

/** localStorage 里存的值 → 偏好。认不出的一律当 `system`。 */
export function asLocalePref(raw: string | null | undefined): LocalePref {
  return raw === 'en' || raw === 'zh-CN' ? raw : 'system';
}

/** localStorage 的键。渲染层与冒烟脚本共用，别各写各的字符串。 */
export const LOCALE_KEY = 'unroll:locale';
