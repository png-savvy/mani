import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useApp } from '../store';
import { fmtDateTime } from '../format';
import { disablePush, enablePush, pushState, testPush, type PushState } from '../push';

interface Device {
  id: number;
  label: string;
  createdAt: string;
  lastOkAt: string | null;
}

export default function NotificationSettings() {
  const { toast } = useApp();
  const [state, setState] = useState<PushState | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    pushState().then(setState).catch(() => setState('unsupported'));
    api.get<{ devices: Device[] }>('/push').then((r) => setDevices(r.devices)).catch(() => {});
  }, []);
  useEffect(load, [load]);

  const act = async (fn: () => Promise<void>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast(done, 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
      load();
    }
  };

  return (
    <section className="card">
      <h2>Notifications</h2>
      <p className="muted small">Get a notification on this device whenever new transactions come in from your bank, so you can categorize them right away.</p>

      {state === 'needs-install' && (
        <p className="callout callout-warn">
          On iPhone and iPad, notifications only work from the Home Screen app: tap the Share button, choose <b>Add to Home Screen</b>, then open
          Mani from there and come back to this page.
        </p>
      )}
      {state === 'unsupported' && <p className="muted small">This browser doesn't support notifications.</p>}
      {state === 'denied' && (
        <p className="callout callout-warn">Notifications are blocked for Mani. Allow them in your phone or browser settings, then reload this page.</p>
      )}

      {(state === 'off' || state === 'on') && (
        <div className="row-gap">
          {state === 'off' ? (
            <button className="btn btn-primary" disabled={busy} onClick={() => act(enablePush, 'Notifications are on for this device')}>
              Turn on for this device
            </button>
          ) : (
            <>
              <span className="tag tag-match">On for this device</span>
              <button className="btn" disabled={busy} onClick={() => act(testPush, 'Test notification sent')}>Send a test</button>
              <button className="btn btn-ghost" disabled={busy} onClick={() => act(disablePush, 'Notifications are off for this device')}>
                Turn off
              </button>
            </>
          )}
        </div>
      )}

      {devices.length > 0 && (
        <div className="push-devices">
          <h3 className="small muted">Devices receiving notifications</h3>
          {devices.map((d) => (
            <div key={d.id} className="row-gap push-device">
              <span>{d.label || 'Device'}</span>
              <span className="muted small">{d.lastOkAt ? `last delivered ${fmtDateTime(d.lastOkAt)}` : `added ${fmtDateTime(d.createdAt)}`}</span>
              <button className="btn btn-tiny btn-ghost" disabled={busy} onClick={() => act(() => api.del(`/push/devices/${d.id}`), 'Device removed')}>
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
