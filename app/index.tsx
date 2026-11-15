/// <reference types="vite/client" />
import '@fontsource/source-serif-4/400.css';
import '@fontsource/source-serif-4/400-italic.css';
import '@fontsource/source-serif-4/500.css';
import '@fontsource/instrument-sans/400.css';
import '@fontsource/instrument-sans/500.css';
import '@fontsource/instrument-sans/600.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import RestoreFailed from './components/RestoreFailed';
import { afterStart, bootRestore } from './utils/restore';
import { initSettingsBackup } from './utils/settingsBackup';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
const render = () => root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// A restore the user started finishes here, before the app (and anything that writes) is up
// (docs/backup.md); while it isn't done, only the failure screen shows.
const boot = async () => {
  const r = await bootRestore();
  if ('pending' in r) {
    root.render(<RestoreFailed pending={r.pending} error={r.error} />);
    return;
  }
  // 083：渲染前读设置快照、决定要不要问恢复、记启动记录；出任何错都不挡启动。
  await Promise.race([initSettingsBackup(), new Promise(r => setTimeout(r, 3000))]);
  render();
  afterStart();
};

// Plain-browser `npm run dev`: fake the Tauri shell (dev/browserMock.ts) first.
if (import.meta.env.DEV && !('__TAURI_INTERNALS__' in window)) {
  import('./dev/browserMock').then(boot);
} else {
  boot();
}