/**
 * 样式层的硬约束（F2 / F3 / F12）+ CSP 回归（§9）。
 *
 * ⚠️ 为什么用「读 CSS 文本 + 断言规则」而不是量 offsetHeight：
 *    jsdom 不做布局，任何元素的 offsetHeight 恒为 0，
 *    `new Set(rows.map(r => r.offsetHeight)).size === 1` 在 jsdom 里
 *    **恒真且毫无意义**（0 个 row 时也过）。
 *    所以这里退一步，断言「使等高成立的 CSS 规则确实存在且没被改掉」，
 *    真正的 F2/F3 目视复核放到 §14.6 端到端冒烟里做（打开 01 号夹具，
 *    DevTools 里量所有 .row 的 offsetHeight 与 .row-preview 的 scrollWidth）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const cssPath = fileURLToPath(new URL('./global.css', import.meta.url));
const css = readFileSync(cssPath, 'utf8');

/** 取某个选择器的规则体 */
function rule(selector: string): string {
  const i = css.indexOf(`${selector} {`);
  expect(i, `找不到规则 ${selector}`).toBeGreaterThan(-1);
  return css.slice(i, css.indexOf('}', i));
}

describe('F2 · 时间线每行固定单行高', () => {
  const body = rule('.row');

  it('高度钉死在 --row-h（height / min-height / max-height 三件套）', () => {
    expect(body).toContain('height: var(--row-h)');
    expect(body).toContain('min-height: var(--row-h)');
    expect(body).toContain('max-height: var(--row-h)');
  });

  it('line-height 与行高一致，字体大小不影响行高', () => {
    expect(body).toContain('line-height: var(--row-h)');
  });

  it('--row-h 是固定像素值，不是内容撑开的 auto', () => {
    expect(rule(':root')).toMatch(/--row-h:\s*\d+px/);
  });
});

describe('F3 · 巨型条目仍只占一行', () => {
  it('.row 永不换行且溢出隐藏', () => {
    const body = rule('.row');
    expect(body).toContain('white-space: nowrap');
    expect(body).toContain('overflow: hidden');
  });

  it('摘要列用省略号截断，而不是撑破布局', () => {
    const body = rule('.row-preview');
    expect(body).toContain('white-space: nowrap');
    expect(body).toContain('text-overflow: ellipsis');
    expect(body).toContain('overflow: hidden');
    // min-width: 0 是 flex 子项能被压缩、省略号才生效的必要条件
    expect(body).toContain('min-width: 0');
  });
});

describe('F12 · 详情面板独立滚动，主区不滚', () => {
  it('body 自身不滚动', () => {
    expect(rule('body')).toContain('overflow: hidden');
  });

  it('.detail-body 自己 overflow:auto', () => {
    expect(rule('.detail-body')).toContain('overflow: auto');
  });

  it('超大正文限高 + 内部滚动（§10.2）', () => {
    const body = rule('.detail-content');
    expect(body).toMatch(/max-height:\s*\d+vh/);
    expect(body).toContain('overflow: auto');
  });

  it('原始 JSON 段同样限高 + 内部滚动', () => {
    const body = rule('.rawjson-pre');
    expect(body).toMatch(/max-height:\s*\d+vh/);
    expect(body).toContain('overflow: auto');
  });
});

describe('F6 · 详情面板未选中时不占宽度', () => {
  it('默认两列，只有 .has-panel 才有第三列', () => {
    expect(rule('.shell-body')).toContain('grid-template-columns: var(--left-w) minmax(0, 1fr)');
    expect(rule('.shell-body.has-panel')).toContain('var(--panel-w)');
  });

  it('§6.1 的尺寸：左 240 / 面板 420 / 顶 28 / 底 26', () => {
    const root = rule(':root');
    expect(root).toContain('--left-w: 240px');
    expect(root).toContain('--panel-w: 420px');
    expect(root).toContain('--top-h: 28px');
    expect(root).toContain('--bottom-h: 26px');
  });
});

describe('§12 Q3 · 项目分组在 240px 里必须保持紧凑', () => {
  it('组头钉死在 20px、11px 字号', () => {
    const body = rule('.session-group-head');
    expect(body).toContain('height: 20px');
    expect(body).toContain('min-height: 20px');
    expect(body).toContain('font-size: 11px');
  });

  it('项目名过长用省略号，不撑破 240px', () => {
    const body = rule('.session-group-label');
    expect(body).toContain('white-space: nowrap');
    expect(body).toContain('text-overflow: ellipsis');
    expect(body).toContain('overflow: hidden');
    expect(body).toContain('min-width: 0');
  });

  it('「组里藏着当前会话」的圆点不参与压缩，颜色走 .g-input class', () => {
    expect(rule('.session-group-dot')).toContain('flex: none');
    expect(css).toContain('.session-group-dot');
  });

  /** 缩进每多一像素都在抢首条用户消息的位置，上限 8px */
  it('组内项缩进 ≤ 8px（基准 padding-left 是 8px）', () => {
    const indent = /padding-left:\s*(\d+)px/.exec(rule('.session-group-items .session-item'));
    expect(indent).not.toBeNull();
    expect(Number(indent![1]) - 8).toBeLessThanOrEqual(8);
    expect(Number(indent![1])).toBeGreaterThan(8);
  });
});

describe('§6.3 · 六组色值在深浅两套主题里都齐全', () => {
  const vars = ['--g-input', '--g-think', '--g-act', '--g-output', '--g-meta', '--g-error'];

  it('浅色', () => {
    for (const v of vars) expect(css).toContain(`${v}: #`);
  });

  it('深色（prefers-color-scheme: dark 块里逐一覆盖）', () => {
    const i = css.indexOf('@media (prefers-color-scheme: dark)');
    expect(i).toBeGreaterThan(-1);
    const dark = css.slice(i, css.indexOf('\n}\n', i));
    for (const v of vars) expect(dark).toContain(v);
  });

  it('每组各有一个 class，组件靠 class 上色（CSP 下不能用行内 style）', () => {
    for (const v of vars) {
      const cls = `.g-${v.replace('--g-', '')}`;
      expect(rule(cls)).toContain(`color: var(${v})`);
    }
  });
});

describe('§9 CSP · 渲染层不得出现行内 style 属性', () => {
  /**
   * 生产 CSP 是 `style-src 'self'`，`style={{...}}` 会被浏览器直接拦掉——
   * 而且开发模式（CSP 宽松）下看不出来，只有打包后才炸。
   * 这条测试就是那道防线。
   */
  const rendererDir = fileURLToPath(new URL('..', import.meta.url));

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return walk(p);
      return /\.tsx?$/.test(name) ? [p] : [];
    });
  }

  it('src/renderer 下所有 .ts/.tsx 都没有 style={{…}}', () => {
    const offenders = walk(rendererDir).filter((p) => {
      if (p.endsWith('global.css.test.ts')) return false; // 本文件里有这个字符串
      return /style=\{\{/.test(readFileSync(p, 'utf8'));
    });
    expect(offenders).toEqual([]);
  });

  it('动态宽度走 CSSOM（setProperty），不是行内 style', () => {
    const hook = readFileSync(fileURLToPath(new URL('../hooks/useResizable.ts', import.meta.url)), 'utf8');
    expect(hook).toContain('documentElement.style.setProperty');
  });
});
