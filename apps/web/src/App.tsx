import { useEffect, useState } from 'react';
import { AuthResponseSchema, LogoutResponseSchema } from '@bid/shared';
import type { AuthResponse } from '@bid/shared';
import { api, ApiError } from './api.js';
import { Login } from './Login.js';
import { Workspace } from './Workspace.js';

export function App() {
  const [auth, setAuth] = useState<AuthResponse | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [darkTheme, setDarkTheme] = useState(() => {
    try {
      return window.localStorage.getItem('theme') === 'dark';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    document.documentElement.dataset.theme = darkTheme ? 'dark' : 'light';

    try {
      window.localStorage.setItem('theme', darkTheme ? 'dark' : 'light');
    } catch {
      // Theme still works for this session when storage is unavailable.
    }
  }, [darkTheme]);

  useEffect(() => {
    let disposed = false;
    setChecking(true);
    setError('');

    void api('/api/auth/me', AuthResponseSchema)
      .then((user) => {
        if (!disposed) setAuth(user);
      })
      .catch((cause: unknown) => {
        if (!disposed && !(cause instanceof ApiError && cause.status === 401)) {
          setError(
            'API is unavailable or its settings are not ready. Check local services and authentication configuration.',
          );
        }
      })
      .finally(() => {
        if (!disposed) setChecking(false);
      });

    return () => {
      disposed = true;
    };
  }, [retry]);

  function clearAuth() {
    setAuth(null);
    window.history.replaceState(null, '', window.location.pathname);
  }

  async function logout() {
    try {
      await api('/api/auth/logout', LogoutResponseSchema, {});
      clearAuth();
    } catch {
      setError('Logout could not reach the server. Try again.');
    }
  }

  return (
    <main className={`app${auth ? ' authenticated' : ' signed-out'}`}>
      {!auth && (
        <button
          className="theme-toggle secondary"
          type="button"
          aria-label={`Switch to ${darkTheme ? 'light' : 'dark'} theme`}
          aria-pressed={darkTheme}
          onClick={() => setDarkTheme((current) => !current)}
        >
          {darkTheme ? '☀ Light' : '☾ Dark'}
        </button>
      )}
      {!auth && (
        <header className="app-header">
          <h1>
            Bid Intelligence<span className="brand-dot">.</span>
          </h1>
          <p className="hint">A clearer view of your auction performance.</p>
        </header>
      )}
      {checking ? (
        <p className="session-status" role="status">
          Checking your login…
        </p>
      ) : (
        <>
          {error && (
            <section className="app-error">
              <p role="alert" className="error">
                {error}
              </p>
              <button className="secondary" onClick={() => setRetry((value) => value + 1)}>
                Check again
              </button>
            </section>
          )}
          {auth ? (
            <Workspace
              key={`${auth.user.userId}:${auth.publisherId}`}
              auth={auth}
              onUnauthorized={clearAuth}
              onLogout={() => void logout()}
              darkTheme={darkTheme}
              onToggleTheme={() => setDarkTheme((current) => !current)}
            />
          ) : (
            <Login onLogin={setAuth} />
          )}
        </>
      )}
    </main>
  );
}
