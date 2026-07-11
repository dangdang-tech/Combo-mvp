import { describe, expect, it, vi } from 'vitest';
import { runCapabilityDeepLink, type CapabilityDeepLinkGuard } from './CapabilityDeepLink.js';

describe('CapabilityDeepLink', () => {
  it('建会话成功后 replace 跳到该会话', async () => {
    const guard: CapabilityDeepLinkGuard = { current: false };
    const createSession = vi.fn(async () => ({ id: 'session-1' }));
    const navigate = vi.fn();

    await runCapabilityDeepLink({ capabilityId: 'cap-1', guard, createSession, navigate });

    expect(createSession).toHaveBeenCalledOnce();
    expect(createSession).toHaveBeenCalledWith('cap-1');
    expect(navigate).toHaveBeenCalledWith('/session/session-1', { replace: true });
  });

  it('建会话失败后 replace 回市集', async () => {
    const guard: CapabilityDeepLinkGuard = { current: false };
    const createSession = vi.fn(async () => {
      throw new Error('capability unavailable');
    });
    const navigate = vi.fn();

    await runCapabilityDeepLink({ capabilityId: 'cap-missing', guard, createSession, navigate });

    expect(createSession).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith('/market', { replace: true });
  });

  it('StrictMode 重跑 effect 时只发一次建会话 POST', async () => {
    const guard: CapabilityDeepLinkGuard = { current: false };
    let resolveSession!: (session: { id: string }) => void;
    const pending = new Promise<{ id: string }>((resolve) => {
      resolveSession = resolve;
    });
    const createSession = vi.fn(() => pending);
    const navigate = vi.fn();
    const input = { capabilityId: 'cap-strict', guard, createSession, navigate };

    const firstEffect = runCapabilityDeepLink(input);
    const secondEffect = runCapabilityDeepLink(input);
    expect(createSession).toHaveBeenCalledOnce();

    resolveSession({ id: 'session-strict' });
    await Promise.all([firstEffect, secondEffect]);
    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith('/session/session-strict', { replace: true });
  });
});
