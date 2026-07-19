import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LandingPage } from './LandingPage.js';

describe('LandingPage', () => {
  it('讲清从真实工作到可交付能力的完整路径', () => {
    render(
      <MemoryRouter>
        <LandingPage />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole('heading', {
        name: /把你反复提供的\s*专业服务，\s*变成\s*可持续交付\s*的 AI 产品/,
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '从你已经做过的事开始' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '把经验变成有结构的产品' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '让别人直接获得你的方法' })).toBeInTheDocument();
    expect(screen.getByText('真实长会话能力提取评审')).toBeInTheDocument();
  });

  it('把主要行动分别连到创作流程与能力示例', () => {
    render(
      <MemoryRouter>
        <LandingPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: /用我的工作记录开始/ })).toHaveAttribute(
      'href',
      '/tasks',
    );
    expect(screen.getByRole('link', { name: /查看一个能力示例/ })).toHaveAttribute(
      'href',
      '/a/cap-wskatc',
    );
  });
});
