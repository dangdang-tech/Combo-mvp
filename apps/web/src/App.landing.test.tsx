import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { App } from './App.js';

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

describe('App landing route', () => {
  it('renders / as a public page without probing the protected session', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    window.history.replaceState({}, '', '/');

    render(<App />);

    expect(
      screen.getByRole('heading', {
        name: /把你反复提供的\s*专业服务，\s*变成\s*可持续交付\s*的 AI 产品/,
      }),
    ).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
