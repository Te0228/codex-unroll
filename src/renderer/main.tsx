import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/global.css';
// v0.2 增量样式拆两份，让并行开发时文件所有权互不相交（见各文件头注释）
import './styles/detail.css';
import './styles/metrics.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root not found in index.html');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
