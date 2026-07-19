import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  THEME_STORAGE_KEY,
  ThemeProvider,
  readThemePreference,
  resolveTheme,
} from './ThemeProvider.js';

interface MatchMediaHarness {
  setDark: (dark: boolean) => void;
}

function installMatchMedia(initialDark = false): MatchMediaHarness {
  let matches = initialDark;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const query = {
    get matches() {
      return matches;
    },
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
      listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
      listeners.delete(listener),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as MediaQueryList;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => query),
  });
  return {
    setDark(dark: boolean) {
      matches = dark;
      const event = { matches: dark, media: query.media } as MediaQueryListEvent;
      listeners.forEach((listener) => listener(event));
    },
  };
}

beforeEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.themePreference;
  document.documentElement.style.colorScheme = '';
  installMatchMedia(false);
});

describe('theme contract', () => {
  it('resolves explicit and system preferences without persisting the resolved value', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('falls back safely when stored input is invalid or storage is blocked', () => {
    expect(readThemePreference({ getItem: () => 'sepia' })).toBe('system');
    expect(
      readThemePreference({
        getItem: () => {
          throw new Error('blocked');
        },
      }),
    ).toBe('system');
  });

  it('offers one accessible toggle and persists the opposite resolved theme', async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <main>Combo</main>
      </ThemeProvider>,
    );

    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    const toggle = screen.getByRole('button', { name: '切换到暗色模式' });
    expect(toggle).toHaveAttribute('data-resolved-theme', 'light');
    await user.click(toggle);

    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(document.documentElement).toHaveAttribute('data-theme-preference', 'dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('uses the resolved system theme as the first explicit toggle target', async () => {
    installMatchMedia(true);
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <main>Combo</main>
      </ThemeProvider>,
    );

    const toggle = screen.getByRole('button', { name: '切换到亮色模式' });
    expect(document.documentElement).toHaveAttribute('data-theme-preference', 'system');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    await user.click(toggle);

    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    expect(document.documentElement).toHaveAttribute('data-theme-preference', 'light');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('follows OS changes only while the system preference is active', async () => {
    const media = installMatchMedia(false);
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <main>Combo</main>
      </ThemeProvider>,
    );

    act(() => media.setDark(true));
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');

    await user.click(screen.getByRole('button', { name: '切换到亮色模式' }));
    act(() => media.setDark(false));
    act(() => media.setDark(true));
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
  });
});
