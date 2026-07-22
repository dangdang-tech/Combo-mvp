import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CLOSED_MARKET_TARGET, ClosedMarketRedirect } from './App.js';

describe('closed market route', () => {
  it('leaves the runtime bundle without rendering market data', async () => {
    const replace = vi.fn();

    render(<ClosedMarketRedirect replace={replace} />);

    expect(screen.getByText('正在返回我的 Agent…')).toBeInTheDocument();
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/capabilities'));
    expect(CLOSED_MARKET_TARGET).toBe('/capabilities');
  });
});
