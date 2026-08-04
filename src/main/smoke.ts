/**
 * §14.6 端到端冒烟。**只在设置了 UNROLL_SHOT 时才被动态 import**，
 * 正常启动路径完全不加载本文件。
 *
 * 存在的理由：F2（每行等高）、F3（巨型条目不撑破布局）、F12（面板独立滚动）
 * 这几条是**布局断言**，jsdom 不做布局（`offsetHeight` 恒为 0），单测里测不了。
 * 这里用 `capturePage()` 直接从渲染器取像素 + `executeJavaScript` 读真实布局值，
 * 不依赖窗口服务器，因此在无头/远程环境也能跑。
 *
 * 用法：
 *   CODEX_HOME=$(pwd)/test UNROLL_SHOT=/tmp/shots npm start
 */
import path from 'node:path';
import type { BrowserWindow } from 'electron';

export interface SmokeResult {
  name: string;
  expected: unknown;
  actual: unknown;
  ok: boolean;
}

export async function runSmoke(
  win: BrowserWindow,
  outDir: string,
  quit: () => void,
): Promise<void> {
  const fs = await import('node:fs/promises');
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const js = <T>(code: string) => win.webContents.executeJavaScript(code, true) as Promise<T>;

  const results: SmokeResult[] = [];
  const check = (name: string, expected: unknown, actual: unknown) => {
    const ok = JSON.stringify(expected) === JSON.stringify(actual);
    results.push({ name, expected, actual, ok });
    console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${name}`, ok ? '' : `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  };
  const shot = async (name: string) => {
    const img = await win.webContents.capturePage();
    await fs.writeFile(path.join(outDir, `${name}.png`), img.toPNG());
  };

  await new Promise<void>((r) => win.webContents.once('did-finish-load', () => r()));
  await wait(1500);

  // ── 第 1 步：左栏列出 3 个夹具会话 ────────────────────────────────
  await shot('1-empty');
  check('F23 空状态拖放区', true, await js(`!!document.querySelector('.dropzone')`));
  check('§14.6-1 列出 3 个会话', 3, await js(`document.querySelectorAll('.session-item').length`));

  // §6.6 按项目分组：夹具是 2 个项目（01/02 同属 openai/codex，03 是 example.com/x）
  check('§6.6 渲染 2 个项目组', 2, await js(`document.querySelectorAll('.session-group-head').length`));
  // 组序按「组内最新活动」倒序，不是按名字——所以这里断言集合而非顺序。
  // 03 号夹具的 mtime 比 01/02 新，`x` 组就该排在前面，这是设计而非 bug。
  check('§6.6 组头文案', ['openai/codex', 'x'], await js(
    `[...document.querySelectorAll('.session-group-label')].map(e=>e.textContent).sort()`));
  check('§6.6 组头挂完整 key 供悬停', ['git:example.com/x', 'git:github.com/openai/codex'], await js(
    `[...document.querySelectorAll('.session-group-head')].map(e=>e.title).sort()`));
  // 顺序改用这条语义断言：组按最新活动倒序 ⇒ 第一组第一条必须是全局最新的那个会话
  check('§6.6 第一组第一条是全局最新', true, await js(
    `(()=>{const items=[...document.querySelectorAll('.session-item')];
       const stamp=e=>e.querySelector('.session-time')?.textContent||'';
       const all=items.map(stamp);
       return stamp(items[0])===all.slice().sort().reverse()[0]})()`));

  // ── 第 2 步：打开 01 号夹具，核对 §14.2 的期望值 ──────────────────
  await js(`Array.from(document.querySelectorAll('.session-item')).find(e=>e.textContent.includes('hello.txt'))?.click()`);
  await wait(800);
  await shot('2-timeline');

  check('F1 时间线 19 行', 19, await js(`document.querySelectorAll('.row').length`));
  // ★ F2：jsdom 测不了，只有真实布局能测。所有行高必须是同一个值
  check('F2 每行等高', 1, await js(`new Set([...document.querySelectorAll('.row')].map(e=>e.offsetHeight)).size`));
  // ★ F3：11 459 字符的条目也不能横向撑破
  check('F3 无横向溢出', true, await js(`[...document.querySelectorAll('.row')].every(e=>e.scrollWidth<=e.clientWidth+1)`));
  check('F5 无摘要卡片区', true, await js(`document.querySelector('.cards')===null`));
  check('F14 六组计数', [6, 2, 2, 4, 5, 0], await js(
    `[...document.querySelectorAll('.fb-group')].map(e=>+e.textContent.match(/\\d+$/)?.[0])`));

  // ── 第 3 步：选中索引 11（apply_patch），核对两层下钻 ──────────────
  await js(`document.querySelectorAll('.row')[11]?.click()`);
  await wait(600);
  await shot('3-detail');
  check('F7 面板标题 apply_patch', true, await js(
    `!!document.querySelector('.detail')?.innerText?.includes('apply_patch')`));
  check('F8 内容以 *** Begin Patch 开头', true, await js(
    `!!document.querySelector('.detail')?.innerText?.includes('*** Begin Patch')`));
  check('F13 恰好两层下钻', 1, await js(`document.querySelectorAll('.detail [aria-expanded]').length`));
  check('F12 body 不滚动', true, await js(`document.body.scrollHeight<=document.body.clientHeight`));

  // ── 第 4 步：03 号夹具，全条目展开后断言零密钥泄漏 ────────────────
  await js(`Array.from(document.querySelectorAll('.session-item')).find(e=>e.textContent.includes('key'))?.click()`);
  await wait(800);
  await js(`document.querySelectorAll('.row').forEach(r=>r.click())`);
  await js(`document.querySelectorAll('.detail [aria-expanded]').forEach(b=>b.click())`);
  await wait(400);
  await shot('4-edge');
  check('A3 边界夹具 13 条', 13, await js(`document.querySelectorAll('.row').length`));
  // ★ §14.6 第 3 步：界面任何位置都搜不到完整 fake key
  check('F22 零密钥泄漏', false, await js(`document.body.innerText.includes('FAKEkeyDoNotUse')`));

  const failed = results.filter((r) => !r.ok);
  console.log(`[smoke] ${results.length - failed.length}/${results.length} passed`);
  console.log('[smoke] DONE');
  setTimeout(() => quit(), 500);
}
