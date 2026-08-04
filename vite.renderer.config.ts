import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * SPEC §9 的 CSP。
 *
 * 必须走 <meta> 而不是响应头：生产是 loadFile()，`file://` 请求不经过
 * Electron 的 webRequest，onHeadersReceived 那条路在打包后不生效。
 *
 * 开发态被迫放宽——Vite 的 React Fast Refresh 要注入 inline script，
 * HMR 要连 ws。这些放宽只存在于 dev server，构建产物拿到的是严格策略。
 */
function csp(): Plugin {
  const PROD = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
  ].join('; ');

  const DEV = [
    "default-src 'none'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self' ws://localhost:* http://localhost:*",
  ].join('; ');

  return {
    name: 'codex-unroll:csp',
    transformIndexHtml(html, ctx) {
      const policy = ctx.server ? DEV : PROD;
      return html.replace(
        '<!--CSP-->',
        `<meta http-equiv="Content-Security-Policy" content="${policy}" />`,
      );
    },
  };
}

// https://vitejs.dev/config
export default defineConfig({
  plugins: [react(), csp()],
});
