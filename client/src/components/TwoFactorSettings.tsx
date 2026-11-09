import { useEffect, useState } from 'react';
import { api } from '../api';
import { useApp } from '../store';
import { Modal } from './ui';

/** Settings card: turn authenticator-app two-step login on/off and manage recovery codes. */
export default function TwoFactorSettings() {
  const { version, toast } = useApp();
  const [status, setStatus] = useState<{ enabled: boolean; recoveryCodesLeft: number } | null>(null);
  const [flow, setFlow] = useState<'setup' | 'disable' | 'newcodes' | null>(null);
  const [codesToShow, setCodesToShow] = useState<string[] | null>(null);

  const load = () =>
    api
      .get('/auth/2fa')
      .then(setStatus)
      .catch((e) => toast(e.message, 'error'));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  if (!status) return null;
  return (
    <div className="twofa">
      <h3>Two-step login</h3>
      {status.enabled ? (
        <>
          <p>
            <span className="tag tag-on">On</span> Logging in needs your password <b>and</b> a code from your authenticator app.{' '}
            <span className="muted">
              {status.recoveryCodesLeft} recovery code{status.recoveryCodesLeft === 1 ? '' : 's'} left.
            </span>
          </p>
          <div className="row-gap">
            <button className="btn btn-small" onClick={() => setFlow('newcodes')}>New recovery codes</button>
            <button className="btn btn-small btn-danger-ghost" onClick={() => setFlow('disable')}>Turn off</button>
          </div>
        </>
      ) : (
        <>
          <p className="muted">
            Recommended if the app can be reached from the internet. After your password you'll also enter a 6-digit code from an authenticator app
            on your phone (Google Authenticator, Microsoft Authenticator, Authy, 1Password…), so a stolen password alone isn't enough.
          </p>
          <button className="btn btn-primary" onClick={() => setFlow('setup')}>Set up two-step login</button>
        </>
      )}

      {flow === 'setup' && (
        <SetupFlow
          onClose={() => {
            setFlow(null);
            load();
          }}
        />
      )}
      {(flow === 'disable' || flow === 'newcodes') && (
        <ConfirmWithCode
          mode={flow}
          onClose={() => setFlow(null)}
          onDone={(codes) => {
            setFlow(null);
            if (codes) setCodesToShow(codes);
            else toast('Two-step login turned off', 'success');
            load();
          }}
        />
      )}
      {codesToShow && <RecoveryCodesModal codes={codesToShow} onClose={() => setCodesToShow(null)} />}
    </div>
  );
}

function SetupFlow({ onClose }: { onClose: () => void }) {
  const { toast } = useApp();
  const [step, setStep] = useState<'password' | 'scan' | 'codes'>('password');
  const [password, setPassword] = useState('');
  const [setup, setSetup] = useState<{ secret: string; qr: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      setSetup(await api.post('/auth/2fa/setup', { password }));
      setStep('scan');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.post<{ recoveryCodes: string[] }>('/auth/2fa/enable', { code });
      setCodes(r.recoveryCodes);
      setStep('codes');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  if (step === 'codes') return <RecoveryCodesModal codes={codes} onClose={onClose} justEnabled />;

  return (
    <Modal title="Set up two-step login" onClose={onClose}>
      {step === 'password' ? (
        <form className="form" onSubmit={start}>
          <p>First, confirm it's you.</p>
          <label>
            Your app password
            <input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </label>
          <button className="btn btn-primary" disabled={!password || busy}>Continue</button>
        </form>
      ) : (
        <form className="form" onSubmit={confirm}>
          <ol className="steps">
            <li>
              Install an authenticator app on your phone if you don't have one (Google Authenticator, Microsoft Authenticator, Authy, 1Password…).
            </li>
            <li>
              In the app, add an account and <b>scan this code</b>:
              <div className="qr-wrap">
                <img src={setup!.qr} alt="QR code for your authenticator app" width={200} height={200} />
              </div>
              <span className="muted small">
                On this phone? Tap <a href={setup!.uri}>open in authenticator app</a>, or type this key in by hand:
              </span>
              <code className="secret-key">{setup!.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
            </li>
            <li>Enter the 6-digit code the app shows:</li>
          </ol>
          <input
            className="code-input"
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123456"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            aria-label="6-digit code"
          />
          <button className="btn btn-primary" disabled={code.replace(/\s/g, '').length !== 6 || busy}>Turn on two-step login</button>
        </form>
      )}
    </Modal>
  );
}

function ConfirmWithCode({
  mode,
  onClose,
  onDone,
}: {
  mode: 'disable' | 'newcodes';
  onClose: () => void;
  onDone: (codes: string[] | null) => void;
}) {
  const { toast } = useApp();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === 'disable') {
        await api.post('/auth/2fa/disable', { password, code });
        onDone(null);
      } else {
        const r = await api.post<{ recoveryCodes: string[] }>('/auth/2fa/recovery-codes', { password, code });
        onDone(r.recoveryCodes);
      }
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={mode === 'disable' ? 'Turn off two-step login' : 'Make new recovery codes'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        {mode === 'newcodes' && <p className="muted">Your old recovery codes will stop working.</p>}
        <label>
          Your app password
          <input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </label>
        <label>
          Code from your authenticator app (or a recovery code)
          <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
        </label>
        <button className={`btn ${mode === 'disable' ? 'btn-danger' : 'btn-primary'}`} disabled={!password || !code || busy}>
          {mode === 'disable' ? 'Turn off' : 'Make new codes'}
        </button>
      </form>
    </Modal>
  );
}

function RecoveryCodesModal({ codes, onClose, justEnabled }: { codes: string[]; onClose: () => void; justEnabled?: boolean }) {
  const [saved, setSaved] = useState(false);
  const text = `Mani — recovery codes (each works once)\n\n${codes.join('\n')}\n`;
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mani-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
    setSaved(true);
  };
  return (
    <Modal title={justEnabled ? 'Two-step login is on ✓' : 'New recovery codes'} onClose={() => saved && onClose()} dismissOnBackdrop={false}>
      <div className="form">
        <p>
          <b>Save these recovery codes somewhere safe</b> (a password manager, or printed). If you lose your phone, each code lets you log in once
          instead of an authenticator code. They won't be shown again.
        </p>
        <div className="recovery-grid">
          {codes.map((c) => (
            <code key={c}>{c}</code>
          ))}
        </div>
        <div className="row-gap">
          <button className="btn" onClick={download}>Download as .txt</button>
          <button
            className="btn"
            onClick={() => {
              navigator.clipboard?.writeText(text).then(() => setSaved(true), () => setSaved(true));
            }}
          >
            Copy
          </button>
        </div>
        <label className="check-inline">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I've saved my recovery codes
        </label>
        <button className="btn btn-primary" disabled={!saved} onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}
