/**
 * 渲染层的本地化运行时（SPEC §15）。
 *
 * `shared/i18n.ts` 是**纯函数目录**：给它一个 locale 才吐字符串。
 * 但组件树里到处传 locale 参数是灾难，所以这一层只干一件事：
 * **把「当前是哪种语言」这个上下文，从 props 里挪到 Context 里。**
 *
 * ── 为什么 Provider 吃的是 `pref` 而不是 `Locale` ──────────────────
 * `'system'` 不是一种语言，是「别问我，去问浏览器」。把解析放在 Provider 内部，
 * 意味着上层只需要保管用户那句表态（localStorage 里的三个值之一），
 * 而 `navigator.language` 这种环境依赖只在这一个地方被读到。
 *
 * ── 为什么 `useT()` 在没有 Provider 时也不报错 ────────────────────
 * 组件单测经常直接渲染某个组件（不套壳），这时 Context 是空的。
 * 让 `useT()` 在这种情况下抛异常，等于逼着每个组件测试都去套 Provider；
 * 让它硬回退成英文，又会让测试里的中文断言莫名其妙地挂。
 * 所以空 Context 时**按环境现算**——和 Provider 走的是同一条解析路径，
 * 差别只是没人替它保管偏好。
 */
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import {
  asLocalePref,
  LOCALE_KEY,
  resolve,
  resolveLocale,
  translate,
  type Locale,
  type LocalePref,
  type MsgKey,
  type MsgParams,
  type Text,
} from '../shared/i18n';

/** `null` 表示「不在 Provider 里」，与「语言是 en」是两回事，别用 DEFAULT_LOCALE 当默认值 */
const LocaleContext = createContext<Locale | null>(null);

/** 浏览器报的系统语言。jsdom / 非浏览器环境下 navigator 可能不存在 */
function systemLanguage(): string | undefined {
  return globalThis.navigator?.language;
}

/**
 * 没有 Provider 时的兜底：直接从环境里现算。
 * localStorage 在隐私模式/沙箱下会抛，一律兜住（同 useViewMode 的口径）。
 */
function ambientLocale(): Locale {
  let raw: string | null = null;
  try {
    raw = globalThis.localStorage?.getItem(LOCALE_KEY) ?? null;
  } catch {
    /* 读不到就当没表过态，落到 'system' */
  }
  return resolveLocale(asLocalePref(raw), systemLanguage());
}

export interface LocaleProviderProps {
  /** 用户偏好（`'system' | 'en' | 'zh-CN'`），不是已解析的语言 */
  pref: LocalePref;
  children: ReactNode;
}

export function LocaleProvider({ pref, children }: LocaleProviderProps) {
  // 结果是个字符串字面量，值没变时 Context 就没变，不需要 useMemo
  const locale = resolveLocale(pref, systemLanguage());

  /**
   * ★ 把语言也打到根元素上，供 CSS 用。
   *
   * 起因是个具体的坏账：`.row-kind` 是**固定 5ch 宽的列**，因为中文的 12 个
   * 分类名被刻意设计成一律两个汉字（列宽稳定是 F2「每行等高」的前提之一）。
   * 英文没有这个性质——`Session` 就是 7 个字符，装不下会把标题列挤歪。
   *
   * 与其把英文缩写成 `Sess` 这种谁也看不懂的东西，不如让**列宽跟着语言走**：
   * CSS 里按 `:root[data-locale='en']` 改一个变量就行，两种语言各自舒服。
   */
  useEffect(() => {
    document.documentElement.dataset.locale = locale;
  }, [locale]);

  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export interface Translator {
  locale: Locale;
  /** key（+ 参数）→ 字符串。UI 自己写死的文案走这条 */
  t: (key: MsgKey, params?: MsgParams) => string;
  /** `Text` → 字符串。`Entry.title` / `Entry.preview` 这类数据层产物走这条 */
  rt: (text: Text) => string;
}

export function useT(): Translator {
  const locale = useContext(LocaleContext) ?? ambientLocale();

  // 身份必须稳定：t / rt 会进下游组件的 memo 依赖和 useMemo 依赖数组，
  // 每次渲染换一对新函数等于把那些 memo 全部作废
  return useMemo(
    () => ({
      locale,
      t: (key: MsgKey, params?: MsgParams) => translate(locale, key, params),
      rt: (text: Text) => resolve(locale, text),
    }),
    [locale],
  );
}
