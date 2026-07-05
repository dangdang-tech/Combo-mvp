// 登录闸门 + 会话身份上下文。试用端所有 runtime 接口都要登录，所以这里仍是硬闸门：
// 未登录/未知态不放行子树。放行后把 MeView 灌进 context，侧栏账号区经 useRuntimeMe 读真身。
// 视觉是 Combo 网格纸底 + 居中面板（rt-auth-gate__panel）。
import { useQuery } from '@tanstack/react-query';
import { MeViewSchema, envelopeSchema, type MeView } from '@cb/shared';
import { createContext, useContext, useState, type ReactNode } from 'react';
import { ComboMark, ComboWordmark } from '../components/ComboBrand.js';
import { loginUrl } from '../navigation/login.js';

const MeEnvelopeSchema = envelopeSchema(MeViewSchema);
const DEV_LOGIN_PATH = '/api/v1/auth/dev-login';
const LOCAL_DEV_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0']);

const RuntimeMeContext = createContext<MeView | null>(null);

/** 当前登录身份（AuthGate 放行后必有值；组件树在闸门内时 null 只是理论兜底）。 */
export function useRuntimeMe(): MeView | null {
  return useContext(RuntimeMeContext);
}

async function fetchMe(
  signal?: AbortSignal,
): Promise<{ status: 'authed'; me: MeView } | { status: 'anon' } | { status: 'error' }> {
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

function canUseLocalDevLogin(): boolean {
  return LOCAL_DEV_HOSTS.has(window.location.hostname);
}

/** 闸门裸页外壳：网格纸底 + 居中 Combo 面板，三态（加载/错误/未登录）共用。 */
function GatePanel({ role, children }: { role: 'status' | 'alert'; children: ReactNode }) {
  return (
    <div className="rt-auth-gate" role={role} aria-live={role === 'status' ? 'polite' : undefined}>
      <div className="rt-auth-gate__panel">
        <span className="rt-auth-gate__brand">
          <ComboMark className="rt-auth-gate__brand-mark" />
          <ComboWordmark className="rt-auth-gate__brand-word" />
        </span>
        <p className="rt-auth-gate__eyebrow">CAPABILITY RUNTIME</p>
        {children}
      </div>
    </div>
  );
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
      <GatePanel role="status">
        <p className="rt-auth-gate__msg">正在确认登录状态…</p>
      </GatePanel>
    );
  }

  if (q.isError || !q.data || q.data.status === 'error') {
    return (
      <GatePanel role="alert">
        <p className="rt-auth-gate__msg">暂时无法确认登录状态，请稍后重试。</p>
        <div className="rt-auth-gate__actions">
          <button type="button" className="rt-btn rt-btn--accent" onClick={() => void q.refetch()}>
            重试
          </button>
        </div>
      </GatePanel>
    );
  }

  if (q.data.status === 'anon') {
    const showDevLogin = canUseLocalDevLogin();
    return (
      <GatePanel role="alert">
        <p className="rt-auth-gate__msg">请先登录后进入试用模式。</p>
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
          {devLoginError ? <p className="rt-auth-gate__error">{devLoginError}</p> : null}
        </div>
      </GatePanel>
    );
  }

  return <RuntimeMeContext.Provider value={q.data.me}>{children}</RuntimeMeContext.Provider>;
}
