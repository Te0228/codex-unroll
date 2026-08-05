/**
 * assets/icon.svg → assets/icon.icns（macOS）+ assets/icon.png（Linux）
 *
 * 为什么用 Electron 光栅化：本机没有 rsvg-convert / inkscape / imagemagick，
 * 而 Electron 本来就是依赖，它自带一个完整的渲染引擎。
 * 图标生成因此不引入任何新依赖，渲染结果也与应用内看到的完全一致。
 *
 * 两个踩过的坑，别改回去：
 *  ⚠️ 必须是 .cjs。Electron 43 的 ESM 主进程里，**静态** `import {app} from 'electron'`
 *     会让 `app.whenReady()` 永远不 resolve（动态 import 才正常）。
 *  ⚠️ 只开**一个**窗口渲染一次 1024，其余尺寸交给 sips 缩放。
 *     反复「销毁透明窗口 → 立刻新建」会在第二次导航时稳定 ERR_FAILED，
 *     换 data: URL 或 loadFile 都一样，问题在窗口不在 URL。
 *
 * 用法：npm run icon
 */
const { app, BrowserWindow } = require('electron');
const { mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

const root = path.resolve(__dirname, '..');
const svg = readFileSync(path.join(root, 'assets/icon.svg'), 'utf8');
const iconset = path.join(root, 'assets/icon.iconset');
const MASTER = 1024;

/** iconutil 要求的完整尺寸集 */
const ENTRIES = [
  [16, 'icon_16x16.png'],
  [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'],
  [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'],
  [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'],
  [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'],
  [1024, 'icon_512x512@2x.png'],
];

async function renderMaster() {
  const win = new BrowserWindow({
    width: MASTER,
    height: MASTER,
    // 摆到屏幕外而不是 show:false —— 隐藏窗口不合成，capturePage 会拿到空白
    x: -4000,
    y: 0,
    show: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    useContentSize: true,
    skipTaskbar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  const html = `<!doctype html><meta charset="utf-8">
    <style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}
    svg{display:block;width:${MASTER}px;height:${MASTER}px}</style>${svg}`;
  const tmp = path.join(os.tmpdir(), 'unroll-icon.html');
  writeFileSync(tmp, html, 'utf8');
  await win.loadFile(tmp);
  await new Promise((r) => setTimeout(r, 400)); // 等 filter / gradient 画完
  const png = (await win.webContents.capturePage()).toPNG();
  win.destroy();
  return png;
}

app.whenReady().then(async () => {
  try {
    rmSync(iconset, { recursive: true, force: true });
    mkdirSync(iconset, { recursive: true });

    const master = path.join(iconset, 'icon_512x512@2x.png');
    writeFileSync(master, await renderMaster());
    console.log(`  master ${MASTER}×${MASTER}`);

    for (const [size, name] of ENTRIES) {
      if (size === MASTER) continue;
      const out = path.join(iconset, name);
      execFileSync('sips', ['-s', 'format', 'png', '-z', String(size), String(size), master, '--out', out], {
        stdio: 'ignore',
      });
      console.log(`  ${name.padEnd(24)} ${size}×${size}`);
    }

    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(root, 'assets/icon.icns')]);
    // Linux / 文档用的 512 PNG
    execFileSync('sips', ['-s', 'format', 'png', '-z', '512', '512', master, '--out', path.join(root, 'assets/icon.png')], {
      stdio: 'ignore',
    });
    rmSync(iconset, { recursive: true, force: true });
    console.log('✓ assets/icon.icns + assets/icon.png');
    app.exit(0);
  } catch (e) {
    console.error('生成失败:', e && e.message);
    app.exit(1);
  }
});
