import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
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

/** Chart/test-safe theme read: app usage stays reactive through ThemeProvider. */
export function useResolvedTheme(): ResolvedTheme {
  const value = useContext(ThemeContext);
  if (value) return value.resolvedTheme;
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

const THEME_OPTIONS: ReadonlyArray<{
  value: ThemePreference;
  label: string;
  shortLabel: string;
  icon: string;
}> = [
  { value: 'system', label: '跟随系统', shortLabel: '系统', icon: '◐' },
  { value: 'light', label: '亮色模式', shortLabel: '亮色', icon: '☀' },
  { value: 'dark', label: '暗色模式', shortLabel: '暗色', icon: '☾' },
];

export function ThemeSwitcher(): ReactElement {
  const { preference, resolvedTheme, setPreference } = useTheme();
  const groupId = useId();

  return (
    <fieldset
      className="cb-theme-switch"
      data-resolved-theme={resolvedTheme}
      aria-label="外观模式"
      title={`当前：${THEME_OPTIONS.find((option) => option.value === preference)?.label ?? '跟随系统'}`}
    >
      <legend className="cb-theme-switch__legend">外观模式</legend>
      {THEME_OPTIONS.map((option) => {
        const id = `${groupId}-${option.value}`;
        return (
          <label
            className="cb-theme-switch__option"
            key={option.value}
            htmlFor={id}
            title={option.label}
          >
            <input
              id={id}
              type="radio"
              name={groupId}
              value={option.value}
              aria-label={option.label}
              checked={preference === option.value}
              onChange={() => setPreference(option.value)}
            />
            <span className="cb-theme-switch__icon" aria-hidden="true">
              {option.icon}
            </span>
            <span className="cb-theme-switch__text">{option.shortLabel}</span>
            <span className="cb-theme-switch__sr">{option.label}</span>
          </label>
        );
      })}
    </fieldset>
  );
}
