import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import test from 'node:test';
import { URL } from 'node:url';

import {
  buildSignInExperiencePayload,
  normalizeEndpoint,
  patchSignInExperience,
  requestManagementToken,
  validateCustomCss,
  verifyPublishedExperience,
} from './publish-logto-branding.mjs';

const cssUrl = new URL('../infra/logto/combo-sign-in.css', import.meta.url);
const workflowUrl = new URL('../.github/workflows/logto-branding.yml', import.meta.url);

test('production endpoint is pinned before credentials can be sent', () => {
  const allowedHosts = new Set(['andkzt.logto.app']);

  assert.equal(
    normalizeEndpoint('https://andkzt.logto.app/', { allowedHosts }),
    'https://andkzt.logto.app',
  );
  assert.throws(
    () => normalizeEndpoint('https://credentials.example/', { allowedHosts }),
    /不在生产允许列表/,
  );
});

test('payload only changes the approved sign-in experience fields', async () => {
  const css = await readFile(cssUrl, 'utf8');
  const payload = buildSignInExperiencePayload(css, {});

  assert.deepEqual(Object.keys(payload), ['color', 'hideLogtoBranding', 'customCss']);
  assert.deepEqual(payload.color, {
    primaryColor: '#a9583e',
    darkPrimaryColor: '#cc785c',
    isDarkModeEnabled: true,
  });
  assert.equal(payload.hideLogtoBranding, true);
  assert.equal(payload.customCss, css);
});

test('optional branding is accepted only as HTTPS URL fields', async () => {
  const css = await readFile(cssUrl, 'utf8');
  const payload = buildSignInExperiencePayload(css, {
    LOGTO_BRANDING_LOGO_URL: 'https://buildwithcombo.com/combo.svg',
    LOGTO_BRANDING_DARK_FAVICON_URL: 'https://buildwithcombo.com/combo-dark.ico',
  });

  assert.deepEqual(payload.branding, {
    logoUrl: 'https://buildwithcombo.com/combo.svg',
    darkFavicon: 'https://buildwithcombo.com/combo-dark.ico',
  });
  assert.throws(
    () =>
      buildSignInExperiencePayload(css, {
        LOGTO_BRANDING_LOGO_URL: 'http://example.com/combo.svg',
      }),
    /必须使用 HTTPS/,
  );
});

test('CSS keeps the current design tokens and stable Logto selectors', async () => {
  const css = await readFile(cssUrl, 'utf8');

  assert.equal(validateCustomCss(css), css);
  for (const token of [
    '#faf9f5',
    '#efe9de',
    '#141413',
    '#3d3d3a',
    '#6c6a64',
    '#e6dfd8',
    '#8e8b82',
    '#cc785c',
    '#a9583e',
  ]) {
    assert.match(css, new RegExp(token));
  }
  for (const selector of [
    'logto_main-content',
    'logto_branding-header',
    'logto_signature',
    '_headline',
    '_wrapper',
    '_inputField',
    '_primary',
    '_createAccount',
  ]) {
    assert.match(css, new RegExp(selector));
  }
  assert.match(css, /content: 'Com'/);
  assert.match(css, /content: 'bo\.'/);
  assert.doesNotMatch(css, /logto_branding-header'] > \*\s*\{/);
  assert.match(css, /height: auto/);
  assert.match(css, /:focus-within/);
  assert.match(css, /#app main\[class\*='logto_main-content'\]/);
  assert.match(css, /flex-direction: row/);
  assert.match(css, /html\[data-theme\] body\.desktop\[class\]/);
  assert.match(css, /html\[data-theme\] body\.mobile\[class\]/);
  assert.match(css, /\[class\$='_inputField'\] fieldset/);
  assert.match(css, /\[class\*='_danger'\]:has/);
  assert.match(css, /input:disabled/);
  assert.match(css, /@media \(prefers-color-scheme: dark\)/);
  assert.doesNotMatch(css, /development[^\n{]*\{[^}]*display\s*:\s*none/is);
});

test('management requests use the expected resource and do not need broad payload fields', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: url.toString(), options });
    return {
      ok: true,
      status: 200,
      json: async () => (calls.length === 1 ? { access_token: 'private-token' } : { ok: true }),
    };
  };

  const accessToken = await requestManagementToken({
    endpoint: 'https://tenant.logto.app',
    clientId: 'management-app',
    clientSecret: 'do-not-log',
    fetchImpl,
  });
  await patchSignInExperience({
    endpoint: 'https://tenant.logto.app',
    accessToken,
    payload: { customCss: '/* valid */' },
    fetchImpl,
  });

  assert.equal(calls[0].url, 'https://tenant.logto.app/oidc/token');
  assert.match(
    calls[0].options.body.toString(),
    /resource=https%3A%2F%2Fdefault\.logto\.app%2Fapi/,
  );
  assert.match(calls[0].options.body.toString(), /scope=all/);
  assert.equal(calls[1].url, 'https://tenant.logto.app/api/sign-in-exp');
  assert.equal(calls[1].options.method, 'PATCH');
  assert.equal(calls[1].options.headers.authorization, 'Bearer private-token');
});

test('publish verification rejects partial or stale API responses', async () => {
  const css = await readFile(cssUrl, 'utf8');
  const payload = buildSignInExperiencePayload(css, {});
  const published = {
    color: payload.color,
    hideLogtoBranding: payload.hideLogtoBranding,
    customCss: payload.customCss,
  };

  assert.equal(verifyPublishedExperience(published, payload), published);
  assert.throws(
    () => verifyPublishedExperience({ ...published, customCss: 'stale' }, payload),
    /customCss/,
  );
  assert.throws(() => verifyPublishedExperience(undefined, payload), /缺少登录体验配置/);
});

test('CLI defaults to dry-run and never prints credentials', () => {
  const result = spawnSync(process.execPath, ['scripts/publish-logto-branding.mjs'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      LOGTO_MANAGEMENT_APP_ID: 'should-never-print-id',
      LOGTO_MANAGEMENT_APP_SECRET: 'should-never-print-secret',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dry-run/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /should-never-print/);
});

test('API errors do not echo free-form server messages', async () => {
  const secret = 'server-echoed-secret';
  const fetchImpl = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: 'invalid_client', error_description: secret, message: secret }),
  });

  await assert.rejects(
    requestManagementToken({
      endpoint: 'https://tenant.logto.app',
      clientId: 'management-app',
      clientSecret: secret,
      fetchImpl,
    }),
    (error) => {
      assert.match(error.message, /401.*invalid_client/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
});

test('production workflow only publishes the reviewed main branch', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');

  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /ref: main/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /environment: production/);
});
