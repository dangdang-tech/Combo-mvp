// ESLint v9 flat config（monorepo 根，覆盖全部 packages/apps）
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      '**/coverage/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      // 骨架阶段：业务路由留 501 占位、端口实现待 Phase 3 注入，允许显式 any 但默认禁
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  // 分层依赖规则（O-07 / 技术方案 §B-01：违反即 CI 失败）：
  // worker/consumer/sweeper 后台进程不得 import api 的 HTTP app / 路由（进程间只经 PG/Redis 间接通信，不得拉起 Fastify app）。
  {
    files: ['apps/api/src/processes/{worker,consumer,sweeper}.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/app', '**/app.js', '**/routes/*', '**/routes/*.js'],
              message:
                '后台进程（worker/consumer/sweeper）不得 import api 的 HTTP app/路由；进程间只经 PG/Redis 间接通信（技术方案 §B-01 分层规则）。',
            },
          ],
        },
      ],
    },
  },
  // 配置文件 / 脚本宽松
  {
    files: ['**/*.config.{js,ts}', 'scripts/**/*.{js,ts,mjs}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  prettier,
);
