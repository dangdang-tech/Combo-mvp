// 测试基建冒烟：确认 jsdom + RTL + jest-dom 匹配器 + 受控 MockFetchEventSource 都就位。
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MockFetchEventSource } from './mockFetchEventSource.js';

describe('test infra smoke', () => {
  it('renders into jsdom and jest-dom matchers work', () => {
    render(<button type="button">点我</button>);
    expect(screen.getByRole('button', { name: '点我' })).toBeInTheDocument();
  });

  it('MockFetchEventSource 连接表初始为空（afterEach 复位）', () => {
    expect(MockFetchEventSource.connections.length).toBe(0);
    expect(MockFetchEventSource.last).toBeUndefined();
  });
});
