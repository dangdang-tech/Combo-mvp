// 当前登录账号（外壳常驻区：侧栏底部头像 + 姓名 · 角色，顶栏右上头像）。
// 真源是 GET /me 的 MeView（RequireAuth 放行后由 ProtectedLayout 注入）。
import { createContext, useContext, type ReactElement, type ReactNode } from 'react';
import type { MeView, Role } from '@cb/shared';

export interface ShellAccount {
  /** 头像 URL；null → 前端首字母占位（非破图）。 */
  avatarUrl: string | null;
  /** 姓名（登录账号名）。 */
  name: string;
  /** 角色展示位（如「创作者」）。 */
  title: string;
}

/** 兜底账号（理论上不可达：ProtectedLayout 只在 authed 后渲染）。 */
export const DEFAULT_ACCOUNT: ShellAccount = {
  avatarUrl: null,
  name: '创作者',
  title: '创作者',
};

/** 角色枚举 → 中文展示标签（展示用，非鉴权口径）。 */
const ROLE_LABEL: Record<Role, string> = {
  creator: '创作者',
};

/** 真实会话身份 MeView → 外壳账号。avatarUrl 暂无（MeView 不含），走首字母兜底。 */
export function accountFromMe(me: MeView): ShellAccount {
  const role = me.roles[0];
  return {
    avatarUrl: null,
    name: me.account,
    title: role ? ROLE_LABEL[role] : '创作者',
  };
}

const AccountContext = createContext<ShellAccount>(DEFAULT_ACCOUNT);

export function AccountProvider({
  account = DEFAULT_ACCOUNT,
  children,
}: {
  account?: ShellAccount;
  children: ReactNode;
}): ReactElement {
  return <AccountContext.Provider value={account}>{children}</AccountContext.Provider>;
}

export function useAccount(): ShellAccount {
  return useContext(AccountContext);
}

/** 兜底头像首字母（avatarUrl 缺省时，非破图）。取姓名首个有效字符大写。 */
export function avatarInitial(name: string): string {
  const ch = Array.from(name.trim())[0] ?? '?';
  return ch.toUpperCase();
}
