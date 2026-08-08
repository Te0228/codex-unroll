/**
 * 「原始 JSON」树视图里**库不管的那一部分**：二次解析（F19）。
 *
 * 树本身由 `react-json-view-lite` 渲染（见 components/JsonTree.tsx）。
 * 实测该库 dist 里行内 style / insertRule / cssText 均为 0 处，
 * 纯 CSS Modules + 自带 index.css，在 `style-src 'self'` 下安全。
 *
 * ★ 只读查看器，不是编辑器（§9 全程不写不改 rollout）——不提供任何可编辑控件。
 */

/** 默认展开到第几层：根 + 一层（即 payload 的直接子项可见），再深就一泻千里 */
export const EXPAND_LEVELS = 2;

function isContainer(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}

/**
 * ★ 二次解析（F19，这次改动里价值最高的一条）。
 *
 * `function_call.arguments` 是 **JSON 字符串**（`"{\"cmd\": \"ls -la\"}"`），
 * 直接显示就是一坨转义符；解析出来当子树渲染才看得懂。
 *
 * ⚠️ 但 `custom_tool_call.input` 是**纯文本 patch**（`*** Begin Patch…`），
 *    绝不能当 JSON 解析。判据是「parse 成功**且**结果是对象或数组」——
 *    parse 成数字/字符串/布尔的一律不算（`"123"` 不能变成数字节点）。
 *    先看首字符是不是 `{` / `[`，避免为每个长字符串白跑一次 JSON.parse。
 *
 * 解析不出来返回 null，**绝不抛异常**（§3.4 宽松解析）。
 */
export function parseNestedJson(value: unknown): unknown | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (s.length < 2) return null;
  const c = s[0];
  if (c !== '{' && c !== '[') return null;
  try {
    const parsed: unknown = JSON.parse(s);
    return isContainer(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 递归预处理：把所有「值是可解析成对象/数组的 JSON 字符串」就地换成解析结果，
 * 然后再喂给 JsonView。这样嵌套 JSON 自然长成子树，不需要库支持什么。
 *
 * ⚠️ 不修改入参——`raw` 是 Entry 上的对象，改了会污染原文视图与后续渲染。
 * ⚠️ 有深度上限：rollout 是外部数据，真出现自引用或病态深度时宁可停在那儿，
 *    也不能让渲染进程栈溢出。
 */
export function expandNestedJson(
  value: unknown,
  /**
   * 可选：把「由二次解析得来的子树」记进这个集合。
   * 渲染时据此让这些节点默认展开——它们本来就是被转义符藏起来的东西，
   * 藏两次没意义（`payload.arguments` 在第 2 层，按层级规则本会是折叠的）。
   */
  nested?: WeakSet<object>,
  depth = 0,
): unknown {
  if (depth > 64) return value;

  const parsed = parseNestedJson(value);
  if (parsed !== null) {
    const out = expandNestedJson(parsed, nested, depth + 1);
    if (nested && typeof out === 'object' && out !== null) nested.add(out);
    return out;
  }

  if (Array.isArray(value)) return value.map((v) => expandNestedJson(v, nested, depth + 1));

  if (isContainer(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = expandNestedJson(v, nested, depth + 1);
    }
    return out;
  }

  return value;
}
