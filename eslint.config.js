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
  // —— 分层依赖规则（后端仓库结构规范：违反即 CI 失败）——
  // ① platform 是领域无关机制，永不依赖业务域 / 组合根 / 进程入口（保证未来 runtime 零改复用）。
  {
    files: ['apps/authoring/src/platform/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/modules/**', '**/bootstrap/**', '**/processes/**'],
              message:
                'platform 是领域无关机制，不得 import 业务域(modules)/组合根(bootstrap)/进程入口(processes)；platform 内不得出现业务表名/业务类型（后端仓库结构规范）。',
            },
          ],
        },
      ],
    },
  },
  // ② 业务域之间只能经对方 index 出口互引，禁止深入模块内部文件（单向无环）。
  {
    files: ['apps/authoring/src/modules/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '../*/repo',
                '../*/repo.js',
                '../*/handlers',
                '../*/handlers.js',
                '../*/routes',
                '../*/routes.js',
                '../*/job',
                '../*/job.js',
                '../*/service',
                '../*/service.js',
                '../*/consumer',
                '../*/consumer.js',
                '../*/projection',
                '../*/projection.js',
              ],
              message:
                '业务域之间只能 import 对方的 index.js 出口，不得深入其内部文件（后端仓库结构规范）。',
            },
          ],
        },
      ],
    },
  },
  // ③ worker/consumer/sweeper 后台进程不得 import Fastify app / 路由聚合（进程间只经 PG/Redis 间接通信，不拉起 Fastify app）。
  {
    files: ['apps/authoring/src/processes/{worker,consumer,sweeper}.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/bootstrap/app',
                '**/bootstrap/app.js',
                '**/bootstrap/routes',
                '**/bootstrap/routes.js',
              ],
              message:
                '后台进程（worker/consumer/sweeper）不得 import HTTP app / 路由聚合（bootstrap）；进程间只经 PG/Redis 间接通信。',
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
