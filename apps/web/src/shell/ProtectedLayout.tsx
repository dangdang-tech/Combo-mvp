// 受保护布局——RequireAuth 放行后渲染：用真实会话身份喂 AccountProvider，再挂创作者外壳 Shell。
//
// 关键修复：守卫确保只有已登录用户到这里，故外壳账号区永远是真实登录人（accountFromMe(me)），
// 不再是硬编码 persona Wayne · CGO（BUG-001）。Shell 内自带 <Outlet>，渲染各受保护子页。
import type { ReactElement } from 'react';
import { Shell } from './Shell.js';
import { AccountProvider } from './account.js';
import { accountFromMe } from './account.js';
import { useAuth } from './auth.js';
import { TopbarSlotProvider } from './topbarSlot.js';

export function ProtectedLayout(): ReactElement {
  const { me } = useAuth();
  // me 必非空：本布局只在 RequireAuth 判定 authed 后渲染（守卫保证）。兜底取默认账号，绝不裸崩。
  const account = me ? accountFromMe(me) : undefined;
  // TopbarSlotProvider 落在 Shell 之上、WizardProvider 之外：让深处 WizardShell 能把「保存草稿」上抬进顶栏。
  return (
    <AccountProvider account={account}>
      <TopbarSlotProvider>
        <Shell />
      </TopbarSlotProvider>
    </AccountProvider>
  );
}
