/**
 * 详情面板的复制（SPEC §5 F18 / §9.1）。
 *
 * 复制出去的**永远是脱敏后的文本**：`preview` 与 `rawPretty` 在归一化层
 * （`shared/rollout.ts`）就已经过 `redact()`，这里一个字都不再加工。
 * §9.1 明写「提供『复制原始 JSON』时同样复制脱敏后的版本——避免用户粘到
 * issue 里泄露」，所以按钮旁常驻一句说明，让用户知道自己粘出去的是遮蔽过的，
 * 而不是以为拿到了原文。
 *
 * ── ★ 为什么要两条复制路径（2026-08-11 在 Electron 43 上实测）──────────
 * 生产是 `loadFile()` → `file://`。实测结论：
 *
 * | 探针 | 结果 |
 * |---|---|
 * | `window.isSecureContext` | **true** —— Chromium 把 `file://` 视为可信来源 |
 * | `navigator.clipboard.writeText` | 存在，`clipboard-write` 权限已是 `granted` |
 * | 窗口**有**焦点时调 async 路径 | resolve，内容确实进了系统剪贴板 |
 * | 窗口**失焦**时调 async 路径 | **reject：`NotAllowedError: Document is not focused`** |
 * | `document.execCommand('copy')` 无用户手势 | 返回 `false`（Chromium 要求手势） |
 * | `document.execCommand('copy')` 有用户手势（真实点击） | **true**，失焦时同样成功 |
 *
 * 也就是说：async 路径是主路，但它有一个真实会踩到的失败面（面板没焦点时点按钮，
 * 例如刚从别的应用切回来）；execCommand 正好补上这一格——它要的是「用户手势」，
 * 而按钮点击本来就是。两条路都保留，且**失败必须说出来**（显示 `ui.copyFailed`），
 * 静默失败是最坏的一种：用户以为复制到了，粘出来是上一次的剪贴板内容。
 *
 * ⚠️ 不许为此加 IPC（Electron 主进程有 `clipboard` 模块，但 §7.3 的 preload
 *    只暴露 8 个方法，验收 E7 用 `Object.keys(window.unroll).length === 8` 钉死）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';

/** 复制结果。`null` = 还没复制过，不显示任何状态 */
type CopyState = 'ok' | 'fail' | null;

/** 状态提示自动消失的毫秒数 */
const FLASH_MS = 1600;

/**
 * 兜底路径：隐藏 textarea + `execCommand('copy')`。
 *
 * 三个细节都不能省：
 *   · 必须真的插进文档并 `select()`——离屏元素也要在渲染树里才能被选中
 *   · 定位靠 class（`.copy-sink`），**不能用行内 style**（CSP `style-src 'self'`）
 *   · `readOnly` 防止 iOS 弹键盘；桌面端无害
 */
function copyViaTextarea(text: string): boolean {
  if (typeof document.execCommand !== 'function') return false;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.readOnly = true;
  ta.className = 'copy-sink';
  ta.setAttribute('aria-hidden', 'true');
  document.body.append(ta);
  try {
    ta.select();
    ta.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    ta.remove();
  }
}

/**
 * 复制一段文本，返回是否成功。
 *
 * 顺序：`navigator.clipboard.writeText` → 失败/不存在 → textarea + execCommand。
 * 两条都跪了才返回 false，由调用方显示 `ui.copyFailed`。
 *
 * 空串直接算失败：剪贴板里放个空串对用户没有意义，还会让「已复制」变成谎话。
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  const api = navigator.clipboard;
  // ⚠️ 不能写成 `await navigator.clipboard?.writeText(t)`：clipboard 不存在时
  //    可选链返回 undefined，await 之后一样是 resolve，会**假报成功**——
  //    用户以为复制到了，粘出来却是上一次的剪贴板内容。必须显式判存在。
  if (api && typeof api.writeText === 'function') {
    try {
      await api.writeText(text);
      return true;
    } catch {
      // 最常见的落点：Document is not focused（面板失焦时点了按钮）
    }
  }
  return copyViaTextarea(text);
}

export interface CopyButtonsProps {
  /** 正文（已脱敏的 preview，译文形态——用户看到什么就复制什么） */
  body: string;
  /** 原始 JSON（已脱敏的 rawPretty） */
  json: string;
}

export function CopyButtons({ body, json }: CopyButtonsProps) {
  const { t } = useT();
  const [state, setState] = useState<CopyState>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 卸载时清掉计时器：换一条记录时面板会重建，晚到的 setState 会警告
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const run = useCallback((text: string) => {
    void copyText(text).then((ok) => {
      setState(ok ? 'ok' : 'fail');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setState(null), FLASH_MS);
    });
  }, []);

  return (
    <div className="detail-copy" role="group" aria-label={t('ui.copy')}>
      {body && (
        <button
          type="button"
          className="copy-btn"
          data-testid="copy-body"
          onClick={() => run(body)}
        >
          {t('ui.copyBody')}
        </button>
      )}
      <button type="button" className="copy-btn" data-testid="copy-json" onClick={() => run(json)}>
        {t('ui.copyJson')}
      </button>

      {/* 结果必须播报出来。role=status 让读屏也听得见，失败尤其不能静默 */}
      <span
        className={`copy-state${state === 'fail' ? ' bad' : ''}`}
        data-testid="copy-state"
        data-state={state ?? ''}
        role="status"
      >
        {state === 'ok' ? t('ui.copied') : state === 'fail' ? t('ui.copyFailed') : ''}
      </span>

      {/* §9.1：常显，别让用户以为粘出去的是原文 */}
      <span className="copy-note" data-testid="copy-note">
        {t('ui.copyRedactedNote')}
      </span>
    </div>
  );
}
