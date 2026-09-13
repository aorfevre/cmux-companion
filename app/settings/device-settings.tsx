'use client';
import { useEffect, useState } from 'react';
import { request } from '../api-request';
export function DeviceSettings() {
  const [host, setHost] = useState('Connecting…'), [error, setError] = useState('');
  const [readOnly, setReadOnly] = useState(() => typeof window === 'undefined' || localStorage.getItem('cmux-companion-read-only') !== 'false');
  const [install, setInstall] = useState<(Event & { prompt?: () => Promise<void> }) | null>(null);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let active = true;
    request<{ connected: boolean; host?: { mac_display_name?: string } }>('/api/bootstrap').then(value => { if (active) setHost(value.connected ? value.host?.mac_display_name || 'Connected to cmux' : 'Waiting for cmux'); }).catch(() => { if (active) setHost('Connection unavailable'); });
    const capture = (event: Event) => { event.preventDefault(); setInstall(event); };
    window.addEventListener('beforeinstallprompt', capture);
    return () => { active = false; window.removeEventListener('beforeinstallprompt', capture); };
  }, []);
  return <section><h2>General</h2><p>Device preferences apply to this browser. Repository and agent settings are shared on the connected Mac.</p>
    <div className="preference-row"><div><strong>Connected Mac</strong><p>{host}</p></div></div>
    <label className="preference-row" htmlFor="protect-input"><span>Protect terminal input<span className="setting-description">Prevent accidental typing into sessions on this device.</span></span><input id="protect-input" type="checkbox" role="switch" checked={readOnly} onChange={event => { try { localStorage.setItem('cmux-companion-read-only', String(event.target.checked)); setReadOnly(event.target.checked); setNotice('Saved on this device'); } catch { setError('This browser could not save the preference.'); } }} /></label>
    {install ? <button onClick={() => void install.prompt?.()}>Add companion to home screen</button> : <p>To install on iPhone, use Share → Add to Home Screen.</p>}
    <p>Private by design: pairing is required on each browser; remote access uses your Tailscale network.</p>
    <button onClick={() => { void request('/api/auth/logout', { method: 'POST', body: '{}' }).then(() => location.assign('/')).catch(() => setError('Could not unpair. Try again.')); }}>Unpair this device</button>
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
