import { useQuery } from '@tanstack/react-query';
import { MeViewSchema, envelopeSchema, type MeView } from '@cb/shared';
import { useState, type ReactNode } from 'react';

const MeEnvelopeSchema = envelopeSchema(MeViewSchema);
const AUTH_LOGIN_PATH = '/api/v1/auth/login';
const DEV_LOGIN_PATH = '/api/v1/auth/dev-login';
const LOCAL_DEV_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0']);

async function fetchMe(signal?: AbortSignal): Promise<{ status: 'authed'; me: MeView } | { status: 'anon' } | { status: 'error' }> {
  let res: Response;
  try {
    res = await fetch('/api/v1/me', {
      method: 'GET',
      credentials: 'include',
      ...(signal ? { signal } : {}),
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    return { status: 'error' };
  }
  if (res.status === 401) return { status: 'anon' };
  if (!res.ok) return { status: 'error' };
  try {
    const body = (await res.json()) as unknown;
    return { status: 'authed', me: MeEnvelopeSchema.parse(body).data };
  } catch {
    return { status: 'error' };
  }
}

function loginUrl(): string {
  const returnTo = window.location.pathname + window.location.search;
  return `${AUTH_LOGIN_PATH}?returnTo=${encodeURIComponent(returnTo || '/try/')}`;
}

function canUseLocalDevLogin(): boolean {
  return LOCAL_DEV_HOSTS.has(window.location.hostname);
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [devLoginError, setDevLoginError] = useState<string | null>(null);
  const [devLoginPending, setDevLoginPending] = useState(false);
  const q = useQuery({
    queryKey: ['runtime-web-me'],
    queryFn: ({ signal }) => fetchMe(signal),
    retry: false,
    staleTime: 5 * 60_000,
  });

  async function runDevLogin() {
    setDevLoginPending(true);
    setDevLoginError(null);
    try {
      const res = await fetch(DEV_LOGIN_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: '{}',
      });
      if (!res.ok) throw new Error('dev-login failed');
      await q.refetch();
    } catch {
      setDevLoginError('本地开发登录不可用，请检查 Docker 是否叠加 dev-test override。');
    } finally {
      setDevLoginPending(false);
    }
  }

  if (q.isPending) {
    return (
      <div className="rt-auth-gate" role="status" aria-live="polite">
        <div className="rt-auth-gate__brand">Agora</div>
        <p>正在确认登录状态…</p>
      </div>
    );
  }

  if (q.isError || !q.data || q.data.status === 'error') {
    return (
      <div className="rt-auth-gate" role="alert">
        <div className="rt-auth-gate__brand">Agora</div>
        <p>暂时无法确认登录状态，请稍后重试。</p>
        <button type="button" className="rt-btn rt-btn--accent" onClick={() => void q.refetch()}>
          重试
        </button>
      </div>
    );
  }

  if (q.data.status === 'anon') {
    const showDevLogin = canUseLocalDevLogin();
    return (
      <div className="rt-auth-gate" role="alert">
        <div className="rt-auth-gate__brand">Agora</div>
        <p>请先登录后进入试用模式。</p>
        <div className="rt-auth-gate__actions">
          <button
            type="button"
            className="rt-btn rt-btn--accent"
            onClick={() => window.location.assign(loginUrl())}
          >
            去登录
          </button>
          {showDevLogin ? (
            <button
              type="button"
              className="rt-btn"
              disabled={devLoginPending}
              onClick={() => void runDevLogin()}
            >
              {devLoginPending ? '登录中…' : '本地开发登录'}
            </button>
          ) : null}
        </div>
        {devLoginError ? <p className="rt-auth-gate__error">{devLoginError}</p> : null}
      </div>
    );
  }

  return <>{children}</>;
}
