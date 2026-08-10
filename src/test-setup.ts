/**
 * 测试环境的全局前置：把界面语言**钉死成 zh-CN**。
 *
 * ── 为什么必须钉 ─────────────────────────────────────────────────
 * jsdom 的 `navigator.language` 恒为 `'en-US'` 且不可改（只读属性），
 * 于是「跟随系统」在测试里永远解析成英文，几百条中文断言会集体变红——
 * 而它们红的原因跟被测逻辑毫无关系。
 *
 * 更根本的理由是：**测试不该依赖运行环境的语言**。不钉的话，同一套用例
 * 在中文 mac 上和 CI 的英文容器里会得到不同结果，那种红是最浪费人的一种。
 *
 * ── 为什么写 localStorage 而不是 mock 掉 i18n ────────────────────
 * localStorage 是产品代码本来就要读的那条路（`useLocalePref` → `LOCALE_KEY`），
 * 走它等于顺带测了偏好读取本身；mock 模块则会把这条路一起蒙掉。
 *
 * ── ★ 光写 localStorage 不够，navigator.language 也得改 ──────────
 * 不少用例在 `beforeEach` 里 `localStorage.clear()`（它们测的是别的持久化状态），
 * 一清就把这里写的偏好一起清掉了，语言当场退回「跟随系统」= jsdom 的 en-US。
 * 而 setup 文件里注册的 beforeEach 跑在用例文件的 beforeEach **之前**，补写也没用。
 * 所以真正兜底的是把 jsdom 的系统语言本身改成中文：这样无论偏好被清成什么样，
 * 「跟随系统」解析出来都还是 zh-CN。
 *
 * ── 为什么这个文件在 src/ 而不是 test/ ──────────────────────────
 * `tsconfig.json` 的 include 只有 `src`，放 test/ 就没人做类型检查了。
 * 文件名不含 `.test.`，不会被 vitest 的 `src/**\/*.test.{ts,tsx}` 收进用例集。
 */
import { LOCALE_KEY } from './shared/i18n';

// 纯函数测试跑在 node 环境，没有 localStorage —— 那种用例本来也不看语言，跳过即可
try {
  globalThis.localStorage?.setItem(LOCALE_KEY, 'zh-CN');
} catch {
  /* 存不下就算了，下面那条才是兜底 */
}

// navigator.language 在 jsdom 里是原型上的 getter，只能用 defineProperty 盖掉
try {
  const nav = globalThis.navigator;
  if (nav) {
    Object.defineProperty(nav, 'language', { value: 'zh-CN', configurable: true });
    Object.defineProperty(nav, 'languages', { value: ['zh-CN', 'zh'], configurable: true });
  }
} catch {
  /* 盖不掉就只能靠上面的 localStorage 了 */
}
