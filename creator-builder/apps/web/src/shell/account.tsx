// 当前登录账号（外壳常驻区，开工总纲 §2.2：侧栏底部头像+姓名+职位、顶栏右上头像）。
//
// 范围诚实：F-04 不含「当前会话账号」后端端点（契约 §60 的 profile 是对外名片，非会话身份）。
// 故此处用 typed context + 可注入 mock 默认值（设计 persona Wayne · CGO）；Phase 4 接真实
// 会话/身份端点时只替换 ViewAccountProvider 的 value，外壳与消费方零改动（D14：外壳恒定）。
import { createContext, useContext, type ReactElement, type ReactNode } from 'react';

export interface ShellAccount {
  /** 头像 URL；null → 前端兜底首字母占位（非破图，对齐契约 avatarUrl 兜底口径）。 */
  avatarUrl: string | null;
  /** 姓名（如 Wayne）。 */
  name: string;
  /** 职位（如 CGO）；展示为「姓名 · 职位」。 */
  title: string;
}

/** 设计 persona 默认账号（开工总纲：Wayne · CGO）。Phase 4 由真实身份端点覆盖。 */
export const DEFAULT_ACCOUNT: ShellAccount = {
  avatarUrl: null,
  name: 'Wayne',
  title: 'CGO',
};

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
