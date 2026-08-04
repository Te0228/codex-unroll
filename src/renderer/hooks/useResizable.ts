/**
 * 详情面板宽度拖拽（F11 / §6.1：默认 420px、最小 320px）。
 *
 * ⚠️ CSP 是 `style-src 'self'`，行内 style 属性会被拦。
 *    宽度这种动态值写到 :root 的自定义属性上——
 *    document.documentElement.style.setProperty 走的是 CSSOM，不受 style-src 限制。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export const PANEL_DEFAULT = 420;
export const PANEL_MIN = 320;
/** 上限不是规格要求，只是别让面板把时间线挤没 */
export const PANEL_MAX_RATIO = 0.7;

export function clampPanelWidth(w: number, viewport = 1280): number {
  const max = Math.max(PANEL_MIN, Math.round(viewport * PANEL_MAX_RATIO));
  if (!Number.isFinite(w)) return PANEL_MIN;
  return Math.min(Math.max(Math.round(w), PANEL_MIN), max);
}

export interface ResizableState {
  width: number;
  setWidth: (w: number) => void;
  dragging: boolean;
  onPointerDown: (e: { clientX: number; preventDefault?: () => void }) => void;
}

/**
 * @param cssVar 写入 :root 的自定义属性名，默认 --panel-w（global.css 用它做列宽）
 */
export function useResizable(cssVar = '--panel-w', initial = PANEL_DEFAULT): ResizableState {
  const [width, setWidthRaw] = useState(() => clampPanelWidth(initial, viewportWidth()));
  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef(false);

  const setWidth = useCallback((w: number) => {
    setWidthRaw(clampPanelWidth(w, viewportWidth()));
  }, []);

  // CSSOM 写变量，不用行内 style
  useEffect(() => {
    document.documentElement.style.setProperty(cssVar, `${width}px`);
  }, [cssVar, width]);

  const onPointerDown = useCallback(
    (e: { clientX: number; preventDefault?: () => void }) => {
      e.preventDefault?.();
      draggingRef.current = true;
      setDragging(true);

      const onMove = (ev: PointerEvent | MouseEvent) => {
        if (!draggingRef.current) return;
        // 面板贴右边：宽度 = 视口宽 - 鼠标 x
        setWidth(viewportWidth() - ev.clientX);
      };
      const onUp = () => {
        draggingRef.current = false;
        setDragging(false);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [setWidth],
  );

  return { width, setWidth, dragging, onPointerDown };
}

function viewportWidth(): number {
  return typeof window === 'undefined' ? 1280 : window.innerWidth || 1280;
}
