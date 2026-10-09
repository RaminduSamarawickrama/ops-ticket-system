import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { ApiError, apiGet, apiSend } from '../api';
import { Header, Spinner } from './Layout';

const AdminContext = createContext<{ username: string; onUnauthorized: () => void } | null>(null);

export function useAdmin() {
  const ctx = useContext(AdminContext);
  if (!ctx) throw new Error('useAdmin must be used inside AdminShell');
  return ctx;
}

/**
 * Wraps admin pages. The server enforces access on every API call; this only decides what to show
 * and sends signed-out visitors to the login page.
 */
export function AdminShell({ children }: { children: ReactNode }) {
  const [username, setUsername] = useState<string | null>(null);
  const navigate = useNavigate();
  const location = useLocation();

  const toLogin = () =>
    navigate(`/admin/login?next=${encodeURIComponent(location.pathname + location.search)}`, { replace: true });

  useEffect(() => {
    apiGet<{ username: string }>('/auth/me')
      .then((r) => setUsername(r.username))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) toLogin();
        else setUsername('');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function logout() {
    await apiSend('POST', '/auth/logout').catch(() => {});
    navigate('/admin/login', { replace: true });
  }

  if (username === null) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <AdminContext.Provider value={{ username, onUnauthorized: toLogin }}>
      <Header
        right={
          <nav className="flex items-center gap-4 text-sm">
            <Link to="/admin" className="text-slate-600 hover:text-ink">
              Dashboard
            </Link>
            {username && <span className="hidden text-slate-500 sm:inline">Signed in as {username}</span>}
            <button type="button" onClick={logout} className="btn-secondary px-3 py-1.5">
              Sign out
            </button>
          </nav>
        }
      />
      {children}
    </AdminContext.Provider>
  );
}
