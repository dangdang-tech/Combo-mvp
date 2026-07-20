#!/usr/bin/env node

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL, URL, URLSearchParams } from 'node:url';

const MANAGEMENT_RESOURCE = 'https://default.logto.app/api';
const DEFAULT_CSS_URL = new URL('../infra/logto/combo-sign-in.css', import.meta.url);
const PRODUCTION_MANAGEMENT_HOSTS = new Set(['andkzt.logto.app']);

export function parseCliArgs(args) {
  const flags = new Set(args);
  const unknown = args.filter((arg) => !['--apply', '--dry-run', '--help'].includes(arg));

  if (unknown.length > 0) {
    throw new Error(`未知参数：${unknown.join(', ')}`);
  }
  if (flags.has('--apply') && flags.has('--dry-run')) {
    throw new Error('--apply 与 --dry-run 不能同时使用');
  }

  return {
    apply: flags.has('--apply'),
    help: flags.has('--help'),
  };
}

export function normalizeEndpoint(value, { required = true, allowedHosts } = {}) {
  if (!value) {
    if (required) {
      throw new Error('缺少 LOGTO_ENDPOINT');
    }
    return undefined;
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('LOGTO_ENDPOINT 必须是合法 URL');
  }

  const localDevelopment = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localDevelopment)) {
    throw new Error('LOGTO_ENDPOINT 必须使用 HTTPS（本机 localhost 调试除外）');
  }
  if (allowedHosts && !allowedHosts.has(url.hostname)) {
    throw new Error(`LOGTO_ENDPOINT 主机不在生产允许列表：${url.hostname}`);
  }

  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function optionalHttpsUrl(value, name) {
  if (!value) {
    return undefined;
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} 必须是合法 URL`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`${name} 必须使用 HTTPS`);
  }
  return url.toString();
}

export function buildBranding(env) {
  const branding = {
    logoUrl: optionalHttpsUrl(env.LOGTO_BRANDING_LOGO_URL, 'LOGTO_BRANDING_LOGO_URL'),
    darkLogoUrl: optionalHttpsUrl(env.LOGTO_BRANDING_DARK_LOGO_URL, 'LOGTO_BRANDING_DARK_LOGO_URL'),
    favicon: optionalHttpsUrl(env.LOGTO_BRANDING_FAVICON_URL, 'LOGTO_BRANDING_FAVICON_URL'),
    darkFavicon: optionalHttpsUrl(
      env.LOGTO_BRANDING_DARK_FAVICON_URL,
      'LOGTO_BRANDING_DARK_FAVICON_URL',
    ),
  };

  return Object.values(branding).some(Boolean)
    ? Object.fromEntries(Object.entries(branding).filter(([, value]) => value))
    : undefined;
}

export function validateCustomCss(customCss) {
  if (!customCss.trim()) {
    throw new Error('主题 CSS 为空');
  }

  const requiredFragments = [
    "[class*='logto_main-content']",
    "[class*='logto_branding-header']",
    "[class*='logto_signature']",
    "[class$='_headline']",
    "[class$='_wrapper']",
    "[class$='_inputField']",
    "[class$='_primary']",
    "[class$='_createAccount']",
    '#faf9f5',
    '#efe9de',
    '#a9583e',
    '#cc785c',
  ];
  const missing = requiredFragments.filter((fragment) => !customCss.includes(fragment));
  if (missing.length > 0) {
    throw new Error(`主题 CSS 缺少稳定契约：${missing.join(', ')}`);
  }
  if (/development[^\n{]*\{[^}]*display\s*:\s*none/is.test(customCss)) {
    throw new Error('主题 CSS 不得隐藏 Logto 开发租户提示');
  }

  return customCss;
}

export function buildSignInExperiencePayload(customCss, env = {}) {
  const branding = buildBranding(env);
  return {
    color: {
      primaryColor: '#a9583e',
      darkPrimaryColor: '#cc785c',
      isDarkModeEnabled: true,
    },
    ...(branding ? { branding } : {}),
    hideLogtoBranding: true,
    customCss: validateCustomCss(customCss),
  };
}

function safeApiError(status, body) {
  // Only expose standardized identifiers. Free-form descriptions can echo
  // request input on some gateways, so never include them in CI output.
  const fields = ['code', 'error'];
  const details =
    body && typeof body === 'object'
      ? fields
          .filter(
            (field) =>
              typeof body[field] === 'string' && /^[a-zA-Z0-9._:-]{1,120}$/.test(body[field]),
          )
          .map((field) => `${field}=${body[field]}`)
          .join('; ')
      : '';
  return `Logto API 返回 ${status}${details ? `（${details}）` : ''}`;
}

async function readJsonResponse(response) {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export async function requestManagementToken({ endpoint, clientId, clientSecret, fetchImpl }) {
  const tokenUrl = new URL('/oidc/token', endpoint);
  const response = await fetchImpl(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      resource: MANAGEMENT_RESOURCE,
      scope: 'all',
    }),
  });
  const body = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(safeApiError(response.status, body));
  }
  if (!body || typeof body.access_token !== 'string' || body.access_token.length === 0) {
    throw new Error('Logto token 响应缺少 access_token');
  }

  return body.access_token;
}

export async function patchSignInExperience({ endpoint, accessToken, payload, fetchImpl }) {
  const response = await fetchImpl(new URL('/api/sign-in-exp', endpoint), {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const body = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(safeApiError(response.status, body));
  }
  return body;
}

export function verifyPublishedExperience(published, payload) {
  if (!published || typeof published !== 'object') {
    throw new Error('Logto API 成功响应缺少登录体验配置');
  }

  const mismatches = [];
  if (published.customCss !== payload.customCss) {
    mismatches.push('customCss');
  }
  if (published.hideLogtoBranding !== payload.hideLogtoBranding) {
    mismatches.push('hideLogtoBranding');
  }
  for (const [name, value] of Object.entries(payload.color)) {
    if (published.color?.[name] !== value) {
      mismatches.push(`color.${name}`);
    }
  }
  for (const [name, value] of Object.entries(payload.branding ?? {})) {
    if (published.branding?.[name] !== value) {
      mismatches.push(`branding.${name}`);
    }
  }

  if (mismatches.length > 0) {
    throw new Error(`Logto API 未确认已发布字段：${mismatches.join(', ')}`);
  }
  return published;
}

export async function run({
  args = process.argv.slice(2),
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const options = parseCliArgs(args);
  if (options.help) {
    globalThis.console.log(`用法：
  pnpm logto:validate        # 默认 dry-run，只校验本地主题
  pnpm logto:publish         # 使用管理 API 发布

发布必需环境变量：LOGTO_ENDPOINT、LOGTO_MANAGEMENT_APP_ID、LOGTO_MANAGEMENT_APP_SECRET`);
    return { mode: 'help' };
  }

  const customCss = await readFile(DEFAULT_CSS_URL, 'utf8');
  const payload = buildSignInExperiencePayload(customCss, env);
  const cssSha256 = createHash('sha256').update(customCss).digest('hex');
  const endpoint = normalizeEndpoint(env.LOGTO_ENDPOINT, {
    required: options.apply,
    ...(options.apply ? { allowedHosts: PRODUCTION_MANAGEMENT_HOSTS } : {}),
  });

  if (!options.apply) {
    globalThis.console.log(
      `Logto 主题校验通过（dry-run）：${Buffer.byteLength(customCss)} bytes, sha256=${cssSha256}`,
    );
    globalThis.console.log(
      `将更新字段：${Object.keys(payload).join(', ')}${endpoint ? `；租户=${new URL(endpoint).host}` : ''}`,
    );
    return { mode: 'dry-run', payload, cssSha256 };
  }

  const clientId = env.LOGTO_MANAGEMENT_APP_ID;
  const clientSecret = env.LOGTO_MANAGEMENT_APP_SECRET;
  if (!clientId) {
    throw new Error('缺少 LOGTO_MANAGEMENT_APP_ID');
  }
  if (!clientSecret) {
    throw new Error('缺少 LOGTO_MANAGEMENT_APP_SECRET');
  }

  const accessToken = await requestManagementToken({
    endpoint,
    clientId,
    clientSecret,
    fetchImpl,
  });
  const published = await patchSignInExperience({ endpoint, accessToken, payload, fetchImpl });
  verifyPublishedExperience(published, payload);
  globalThis.console.log(
    `Logto 登录体验发布成功：租户=${new URL(endpoint).host}, css sha256=${cssSha256}`,
  );
  return { mode: 'apply', cssSha256 };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  run().catch((error) => {
    globalThis.console.error(
      `Logto 主题发布失败：${error instanceof Error ? error.message : '未知错误'}`,
    );
    process.exitCode = 1;
  });
}
