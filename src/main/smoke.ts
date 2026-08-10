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

  /**
   * 轮询等待一个条件成立，而不是「固定 sleep 然后祈祷」。
   *
   * 之前用 `await wait(1500)` 当就绪判据，结果是间歇性假失败：
   * listSessions 是异步 IPC，机器一忙就赶不上，冒烟会报「0 个会话」——
   * 而应用本身完全正常。发布门禁不能有这种噪音。
   */
  const waitFor = async (expr: string, label: string, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await js<boolean>(`!!(${expr})`)) return true;
      if (Date.now() > deadline) {
        console.error(`[smoke] TIMEOUT 等待 ${label} 超过 ${timeoutMs}ms`);
        return false;
      }
      await wait(100);
    }
  };

  const results: SmokeResult[] = [];
  const check = (name: string, expected: unknown, actual: unknown) => {
    const ok = JSON.stringify(expected) === JSON.stringify(actual);
    results.push({ name, expected, actual, ok });
    console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${name}`, ok ? '' : `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  };
  /**
   * capturePage 拿的是最近**已绘制**的一帧，DOM 更新后立刻截会抓到旧画面
   * （实测出现过「断言查到树节点、截图里却还是折叠态」）。
   * 先等两帧再截。断言读的是 DOM 状态、不受此影响，这里只为让截图可信。
   */
  const shot = async (name: string) => {
    await js(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
    await wait(150);
    const img = await win.webContents.capturePage();
    await fs.writeFile(path.join(outDir, `${name}.png`), img.toPNG());
  };

  /**
   * ★ 等首次加载完成。**不能只监听 did-finish-load**：
   * 本模块是动态 import 进来的，等它 resolve 时页面往往**已经加载完了**，
   * 事件早就发过，监听器再挂上去就永远等不到——冒烟会静默挂死，
   * 一条 PASS/FAIL 都不打印。（和当年 `await wait(1500)` 是同一类错误：
   * 把「时序恰好合适」当成了判据。）
   *
   * 所以：先问状态，再监听；两边都不成立时用超时兜底。
   * 后面每一步本来就是 waitFor 轮询，这里早一点晚一点都能自愈，
   * 唯独**永久挂起**不能接受——发布门禁必须要么绿要么红。
   */
  await new Promise<void>((resolve) => {
    if (!win.webContents.isLoading()) return resolve();
    const done = () => resolve();
    win.webContents.once('did-finish-load', done);
    setTimeout(done, 20000);
  });

  // ── 第 1 步：左栏列出 3 个夹具会话 ────────────────────────────────
  await waitFor(`document.querySelector('.dropzone')`, '空状态渲染');
  await shot('1-empty');
  // 会话扫描是异步 IPC。不等它落地就断言，测的是竞态不是功能。
  await waitFor(`document.querySelectorAll('.session-item').length`, '会话列表加载');

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
  await waitFor(`document.querySelectorAll('.row').length`, '时间线渲染');

  // ★ 视图偏好存在 localStorage 里，上一次跑留下的值会带到这一次。
  //   所以每组断言前**显式点到**要测的视图，不依赖默认值——否则这几条会随机漂。
  await js(`document.querySelector('[data-testid="view-graph"]')?.click()`);
  await waitFor(`document.querySelector('[data-testid="graph"]')`, '图视图渲染');
  await shot('2-graph');

  // ── §6.8 图视图：Session ▸ Turn ▸ Step 竖向链 ─────────────────────
  check('§6.8 1 个 Turn', 1, await js(`document.querySelectorAll('[data-testid="turn"]').length`));
  check('§6.8 2 个 Step', 2, await js(`document.querySelectorAll('[data-testid="step"]').length`));
  // Step 1 调工具 → 循环继续；Step 2 只回消息 → 出环
  check('§6.8 收场 act → answer', ['act', 'answer'], await js(
    `[...document.querySelectorAll('[data-testid="step"]')].map(e=>e.dataset.outcome)`));
  check('§6.8 两个 Step 之间 1 条连接线', 1, await js(
    `document.querySelectorAll('[data-testid="step-link"]').length`));
  check('§6.8 块尾 token 数（§14.2 C11 的会话合计出现在 Step 2）', true, await js(
    `[...document.querySelectorAll('[data-testid="step-usage"]')].map(e=>e.textContent).join('|').includes('34188 → 263')`));
  check('§6.8 Turn 头带冻结配置', true, await js(
    `!!document.querySelector('.turn-config')?.textContent?.includes('read-only')`));
  // ★ 前言默认全展开——查看器的职责是「摊开」不是「摘要」
  check('§6.8 Turn 前言默认展开', 'true', await js(
    `document.querySelector('[data-testid="turn-preamble-toggle"]')?.getAttribute('aria-expanded')`));
  // ★ 一条都不能少：19 条 = 16 行 + 2 个 Step 块尾 + 1 个 Turn 尾
  check('§6.8 19 条全有归宿（16 行 + 2 块尾 + 1 Turn 尾）', [16, 2, 1], await js(
    `[document.querySelectorAll('[data-testid="graph"] .row').length,
      document.querySelectorAll('[data-testid="step-usage"]').length,
      document.querySelectorAll('[data-testid="turn-end"]').length]`));
  // ★ 图里 F2/F3 同样成立——块只承载结构，行仍是固定单行（§6.0 的前提没变）
  check('§6.8 图里每行仍等高', 1, await js(
    `new Set([...document.querySelectorAll('[data-testid="graph"] .row')].map(e=>e.offsetHeight)).size`));
  check('§6.8 图无横向溢出', true, await js(
    `(()=>{const g=document.querySelector('[data-testid="graph"]');
       return g.scrollWidth<=g.clientWidth+1})()`));

  // ── 切到列表视图，跑原有的 §14.4 布局断言 ─────────────────────────
  await js(`document.querySelector('[data-testid="view-list"]')?.click()`);
  await waitFor(`document.querySelector('[data-testid="timeline"]')`, '列表视图渲染');
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
  await waitFor(`document.querySelector('.detail')`, '详情面板出现');
  await shot('3-detail');
  check('F7 面板标题 apply_patch', true, await js(
    `!!document.querySelector('.detail')?.innerText?.includes('apply_patch')`));
  check('F8 内容以 *** Begin Patch 开头', true, await js(
    `!!document.querySelector('.detail')?.innerText?.includes('*** Begin Patch')`));
  // F13：层级看的是「顶层可折叠区段」，树内部节点的展开属于本层内部导航，不计（§14.8）
  check('F13 恰好两层下钻', 1, await js(`document.querySelectorAll('.detail [data-drill]').length`));

  // ── §6.7 原始 JSON 树视图（react-json-view-lite）在严格 CSP 下的实测 ──
  await js(`document.querySelector('[data-testid="rawjson-toggle"]')?.click()`);
  await waitFor(`document.querySelector('[data-testid="rawjson-body"]')`, '原始 JSON 展开');
  check('§6.7 树已渲染（库在 CSP 下存活）', true, await js(
    `document.querySelectorAll('[data-testid="rawjson-body"] [role="treeitem"], [data-testid="rawjson-body"] [role="tree"]').length > 0`));
  // 库的样式来自打包进来的 CSS 文件；若被 CSP 拦掉，节点会退化成无缩进的裸文本。
  // 探的是树内部真实节点的缩进，不是外层容器。
  check('§6.7 库的结构样式已生效（缩进存在）', true, await js(
    `(()=>{const items=[...document.querySelectorAll('[data-testid="rawjson-body"] [role="treeitem"]')];
       if(items.length===0) return false;
       return items.some(e=>parseFloat(getComputedStyle(e).paddingLeft||'0')>0
                          || parseFloat(getComputedStyle(e).marginLeft||'0')>0)})()`));
  // 我们自己接的六组语义色是否真的落到值节点上
  check('§6.7 值节点着色生效', true, await js(
    `(()=>{const el=document.querySelector('[data-testid="rawjson-body"] .jt-string, [data-testid="rawjson-body"] .jt-number');
       if(!el) return false;
       const c=getComputedStyle(el).color;
       return !!c && c!=='rgba(0, 0, 0, 0)' && c!=='rgb(0, 0, 0)'})()`));
  check('§6.7 树里也搜不到明文 key', false, await js(
    `document.querySelector('[data-testid="rawjson-body"]').innerText.includes('FAKEkeyDoNotUse')`));
  await shot('5-jsontree');
  check('F12 body 不滚动', true, await js(`document.body.scrollHeight<=document.body.clientHeight`));

  // ── 第 4 步：03 号夹具，全条目展开后断言零密钥泄漏 ────────────────
  await js(`Array.from(document.querySelectorAll('.session-item')).find(e=>e.textContent.includes('key'))?.click()`);
  await waitFor(`document.querySelectorAll('.row').length===13`, '03 号夹具渲染');
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
