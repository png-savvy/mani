import { api } from './api';

export type PushState =
  | 'unsupported' // this browser can't do web push at all
  | 'needs-install' // iPhone/iPad: only works once added to the Home Screen
  | 'denied' // the user blocked notifications for this site
  | 'off'
  | 'on';

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;

export function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('Service worker registration failed:', e));
    });
  }
}

async function registration() {
  return navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready);
}

export async function pushState(): Promise<PushState> {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (!supported) return isIOS() && !isStandalone() ? 'needs-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const sub = await (await registration()).pushManager.getSubscription();
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

function keyBytes(base64url: string) {
  const b64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function deviceLabel() {
  const ua = navigator.userAgent;
  const device = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Browser';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return browser ? `${device} · ${browser}` : device;
}

/** Asks permission (must be called from a tap) and registers this device. */
export async function enablePush(): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications were not allowed. You can allow them in your phone or browser settings.');
  const reg = await registration();
  const { publicKey } = await api.get<{ publicKey: string }>('/push');
  let sub = await reg.pushManager.getSubscription();
  if (sub) {
    // A subscription made for a different server key can't receive our messages; replace it.
    const current = sub.options.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
    const wanted = keyBytes(publicKey);
    if (!current || current.length !== wanted.length || current.some((b, i) => b !== wanted[i])) {
      await sub.unsubscribe();
      sub = null;
    }
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  await api.post('/push/subscribe', { subscription: sub.toJSON(), label: deviceLabel() });
}

export async function disablePush(): Promise<void> {
  const sub = await (await registration()).pushManager.getSubscription();
  if (!sub) return;
  await api.post('/push/unsubscribe', { endpoint: sub.endpoint });
  await sub.unsubscribe();
}

export async function testPush(): Promise<void> {
  const sub = await (await registration()).pushManager.getSubscription();
  await api.post('/push/test', { endpoint: sub?.endpoint });
}
