import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AppShell } from './AppShell.js';

describe('AppShell', () => {
  it('starts with the runtime content instead of rendering the redundant topbar', () => {
    const markup = renderToStaticMarkup(createElement(AppShell));

    expect(markup).toContain('<main class="rt-shell__main"></main>');
    expect(markup).not.toContain('<header');
    expect(markup).not.toContain('COMBO · CAPABILITY RUNTIME');
  });
});
