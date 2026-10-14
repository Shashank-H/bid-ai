import { useState } from 'react';
import type { FormEvent } from 'react';
import { AuthResponseSchema } from '@bid/shared';
import type { AuthResponse } from '@bid/shared';
import { api } from './api.js';

export function Login({ onLogin }: { onLogin: (auth: AuthResponse) => void }) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');

    try {
      onLogin(await api('/api/auth/login', AuthResponseSchema, { login, password }));
      setPassword('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Login could not be completed.');
    } finally {
      setBusy(false);
    }
  }

  return <section className="status-panel" aria-labelledby="login-heading">
    <h2 id="login-heading">Publisher login</h2>
    <p className="hint">Use your explicitly bootstrapped development account (demo.a or demo.b).</p>
    <form onSubmit={(event) => void submit(event)} className="login-form">
      <label htmlFor="login">Login</label>
      <input id="login" autoComplete="username" value={login} onChange={(event) => setLogin(event.target.value)} required maxLength={254} disabled={busy} />
      <label htmlFor="password">Password</label>
      <input id="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={12} maxLength={256} disabled={busy} />
      {error && <p role="alert" className="error">{error}</p>}
      <button disabled={busy} type="submit">{busy ? 'Logging in…' : 'Log in'}</button>
    </form>
  </section>;
}
