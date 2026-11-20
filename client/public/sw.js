// Mani service worker: shows push notifications and opens the app when one is tapped.
// It deliberately does not cache anything, so the app is always the latest version from your server.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Mani', {
      body: data.body || '',
      // Large picture: the coin on a transparent background. Badge: the small status-bar icon, which Android draws from
      // the image's shape only (a full-colour picture there turns into a plain white blob).
      icon: '/mani-notify-icon.png',
      badge: '/mani-notify-badge.png',
      tag: data.tag,
      renotify: !!data.tag,
      data: { url: data.url || '/review' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const w of windows) {
        if (new URL(w.url).origin !== self.location.origin) continue;
        try {
          await w.navigate(url);
        } catch {
          // Not controlled by this worker yet; focusing is still better than opening a second copy.
        }
        return w.focus();
      }
      return self.clients.openWindow(url);
    })(),
  );
});
