// ① 身份区测试（主页-02/21）——六项齐全、社交计数真实且万-k 规整、头像缺图兜底（不破图）。
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HeroSection } from './HeroSection.js';
import { makeHero } from '../fixtures.js';

describe('HeroSection ① 身份区', () => {
  it('渲染头像/昵称/身份标签/简介/三社交计数六项', () => {
    render(<HeroSection hero={makeHero()} />);
    expect(screen.getByRole('heading', { name: 'Wayne' })).toBeInTheDocument();
    expect(screen.getByText('增长黑客')).toBeInTheDocument();
    expect(screen.getByText('保险经纪')).toBeInTheDocument();
    expect(screen.getByText('把会话沉淀成能力。')).toBeInTheDocument();
    expect(screen.getByText('关注')).toBeInTheDocument();
    expect(screen.getByText('粉丝')).toBeInTheDocument();
    expect(screen.getByText('获赞')).toBeInTheDocument();
  });

  it('社交计数真实，大数走 compactNumber 规整（3400 → 3,400）', () => {
    render(<HeroSection hero={makeHero()} />);
    expect(screen.getByText('3,400')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('128')).toBeInTheDocument();
  });

  it('avatarUrl=null → 兜底首字母占位，不破图（无 img）', () => {
    const { container } = render(<HeroSection hero={makeHero({ avatarUrl: null })} />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('W')).toBeInTheDocument();
  });

  it('avatarUrl 有值 → 渲染 img', () => {
    render(<HeroSection hero={makeHero({ avatarUrl: 'https://x/a.png' })} />);
    expect(screen.getByRole('img', { name: 'Wayne 头像' })).toBeInTheDocument();
  });
});
