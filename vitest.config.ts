import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    // 纯函数测试跑 node，组件测试在文件头用 `// @vitest-environment jsdom` 切换
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    // 语言钉死成 zh-CN，理由见该文件头（jsdom 的 navigator.language 恒为 en-US）
    setupFiles: ['./src/test-setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/shared/**'],
      // §14.7：shared 是纯函数，没理由低于 90%
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
    },
  },
});
