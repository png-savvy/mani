import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './styles.css';
import { registerServiceWorker } from './push';

registerServiceWorker();

// An installed app stays loaded for days, so it never picks up updates by itself. Whenever it comes back to the
// foreground (and every few minutes), ask the server which build it is serving and reload if that has changed.
let loadedBuild: string | null = null;
async function checkForUpdate() {
  try {
    const { build } = (await (await fetch('/api/version', { cache: 'no-store' })).json()) as { build: string };
    if (loadedBuild === null) loadedBuild = build;
    else if (build !== loadedBuild && build !== 'dev') {
      // Don't yank the page away mid-typing; it will reload on the next check instead.
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName ?? '');
      if (!typing) window.location.reload();
    }
  } catch {
    // offline or server restarting: try again later
  }
}
checkForUpdate();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') checkForUpdate();
});
setInterval(checkForUpdate, 5 * 60000);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
