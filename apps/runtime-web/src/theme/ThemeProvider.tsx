import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = Exclude<ThemePreference, 'system'>;

export const THEME_STORAGE_KEY = 'combo.theme.preference';
const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)';

const isThemePreference = (value: unknown): value is ThemePreference =>
  value === 'system' || value === 'light' || value === 'dark';

function themeMediaQuery(): MediaQueryList | null {
  try {
    return typeof window.matchMedia === 'function' ? window.matchMedia(DARK_MEDIA_QUERY) : null;
  } catch {
    return null;
  }
}

export function readThemePreference(storage?: Pick<Storage, 'getItem'>): ThemePreference {
  try {
    const source = storage ?? window.localStorage;
    const value = source.getItem(THEME_STORAGE_KEY);
    return isThemePreference(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark = themeMediaQuery()?.matches ?? false,
): ResolvedTheme {
  return preference === 'system' ? (systemPrefersDark ? 'dark' : 'light') : preference;
}

export function applyTheme(
  preference: ThemePreference,
  systemPrefersDark = themeMediaQuery()?.matches ?? false,
): ResolvedTheme {
  const resolved = resolveTheme(preference, systemPrefersDark);
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.themePreference = preference;
  root.style.colorScheme = resolved;
  return resolved;
}

function persistThemePreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // The UI still works when storage is blocked (private mode / embedded webviews).
  }
}

function initialThemePreference(): ThemePreference {
  const fromHead = document.documentElement.dataset.themePreference;
  return isThemePreference(fromHead) ? fromHead : readThemePreference();
}

interface ThemeContextValue {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }): ReactElement {
  const [preference, setPreferenceState] = useState<ThemePreference>(initialThemePreference);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => applyTheme(preference));

  const syncPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    setResolvedTheme(applyTheme(next));
  }, []);

  const setPreference = useCallback(
    (next: ThemePreference) => {
      persistThemePreference(next);
      syncPreference(next);
    },
    [syncPreference],
  );

  useEffect(() => {
    const query = themeMediaQuery();
    if (!query || preference !== 'system') return undefined;

    const onChange = (event: MediaQueryListEvent): void => {
      setResolvedTheme(applyTheme('system', event.matches));
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [preference]);

  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key !== THEME_STORAGE_KEY) return;
      syncPreference(isThemePreference(event.newValue) ? event.newValue : 'system');
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [syncPreference]);

  const value = useMemo(
    () => ({ preference, resolvedTheme, setPreference }),
    [preference, resolvedTheme, setPreference],
  );

  return (
    <ThemeContext.Provider value={value}>
      {children}
      <ThemeSwitcher />
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used within ThemeProvider');
  return value;
}

export function ThemeSwitcher(): ReactElement {
  const { resolvedTheme, setPreference } = useTheme();
  const nextTheme: ResolvedTheme = resolvedTheme === 'dark' ? 'light' : 'dark';
  const currentLabel = resolvedTheme === 'dark' ? '暗色' : '亮色';
  const nextLabel = nextTheme === 'dark' ? '暗色' : '亮色';

  return (
    <button
      type="button"
      className="cb-theme-switch"
      data-resolved-theme={resolvedTheme}
      aria-label={`切换到${nextLabel}模式`}
      title={`当前${currentLabel}模式，点击切换到${nextLabel}模式`}
      onClick={() => setPreference(nextTheme)}
    >
      {resolvedTheme === 'dark' ? (
        <svg className="cb-theme-switch__icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M20.2 15.4A8.5 8.5 0 0 1 8.6 3.8 8.5 8.5 0 1 0 20.2 15.4Z" />
        </svg>
      ) : (
        <svg className="cb-theme-switch__icon" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="3.5" />
          <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" />
        </svg>
      )}
    </button>
  );
}
