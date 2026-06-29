// 账号常驻区测试（外壳首页-02：头像+姓名+职位；avatarUrl 缺省走兜底首字母，非破图）。
import type { ReactElement } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  AccountProvider,
  useAccount,
  avatarInitial,
  DEFAULT_ACCOUNT,
  type ShellAccount,
} from './account.js';

function Probe(): ReactElement {
  const a = useAccount();
  return <span data-testid="probe">{`${a.name}·${a.title}`}</span>;
}

describe('avatarInitial 兜底首字母', () => {
  it('取姓名首字符大写', () => {
    expect(avatarInitial('Wayne')).toBe('W');
    expect(avatarInitial('张三')).toBe('张');
  });

  it('空姓名兜底为 ?（不破图、不抛错）', () => {
    expect(avatarInitial('   ')).toBe('?');
    expect(avatarInitial('')).toBe('?');
  });
});

describe('AccountProvider / useAccount', () => {
  it('默认提供 persona Wayne · CGO', () => {
    expect(DEFAULT_ACCOUNT).toEqual({ avatarUrl: null, name: 'Wayne', title: 'CGO' });
    render(
      <AccountProvider>
        <Probe />
      </AccountProvider>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('Wayne·CGO');
  });

  it('可注入自定义账号（Phase 4 接真实身份端点的接缝）', () => {
    const custom: ShellAccount = { avatarUrl: null, name: 'Lea', title: 'PM' };
    render(
      <AccountProvider account={custom}>
        <Probe />
      </AccountProvider>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('Lea·PM');
  });

  it('无 Provider 时回退默认（不抛错）', () => {
    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('Wayne·CGO');
  });
});
