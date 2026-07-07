// demo 画廊应用本体：收集 src 下所有 *.stories.tsx 导出的 group（StoryGroup），
// 按 title 排序渲染成「左侧锚点目录 + 右侧分节展示」的画廊，顶部提供主题切换与组件筛选。
import '@cb/ds-tokens/tokens.css';
import './demo.css';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { type StoryGroup } from '../src/story-types';

// 副作用引入全部组件样式：即使某个组件源码没有显式 import 自己的 css，画廊里也能看到完整外观。
import.meta.glob('../src/**/*.css', { eager: true });

const storyModules = import.meta.glob('../src/**/*.stories.tsx', { eager: true }) as Record<
  string,
  { group?: StoryGroup }
>;

const groups: StoryGroup[] = Object.values(storyModules)
  .map((mod) => mod.group)
  .filter((g): g is StoryGroup => g !== undefined)
  .sort((a, b) => a.title.localeCompare(b.title));

type Theme = 'light' | 'dark';

function App() {
  const [theme, setTheme] = useState<Theme>('light');
  const [selected, setSelected] = useState<string>('all');

  const applyTheme = (next: Theme) => {
    setTheme(next);
    document.documentElement.dataset.cbTheme = next;
  };

  const visibleGroups =
    selected === 'all' ? groups : groups.filter((g) => g.component === selected);

  return (
    <div className="cb-demo-layout">
      <aside className="cb-demo-sidebar">
        <p className="cb-demo-brand">Combo DS</p>
        <nav className="cb-demo-nav" aria-label="组件目录">
          {groups.map((g) => (
            <a key={g.component} className="cb-demo-nav-link" href={`#group-${g.component}`}>
              {g.title}
            </a>
          ))}
        </nav>
      </aside>
      <main className="cb-demo-main">
        <header className="cb-demo-toolbar">
          <h1 className="cb-demo-title">组件画廊</h1>
          <div className="cb-demo-controls">
            <label className="cb-demo-control">
              筛选
              <select
                className="cb-demo-select"
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
              >
                <option value="all">全部组件</option>
                {groups.map((g) => (
                  <option key={g.component} value={g.component}>
                    {g.title}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="cb-demo-theme-toggle"
              onClick={() => applyTheme(theme === 'light' ? 'dark' : 'light')}
            >
              {theme === 'light' ? '切换到 Dark' : '切换到 Light'}
            </button>
          </div>
        </header>
        {visibleGroups.map((g) => (
          <section key={g.component} id={`group-${g.component}`} className="cb-demo-group">
            <h2 className="cb-demo-group-title">{g.title}</h2>
            {g.stories.map((story) => (
              <article key={story.name} className="cb-demo-story">
                <header className="cb-demo-story-head">
                  <span className="cb-demo-story-name">{story.name}</span>
                  {story.note !== undefined && (
                    <span className="cb-demo-story-note">{story.note}</span>
                  )}
                </header>
                <div className="cb-demo-story-canvas">{story.render()}</div>
              </article>
            ))}
          </section>
        ))}
      </main>
    </div>
  );
}

const rootEl = document.getElementById('root');
if (rootEl !== null) {
  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
