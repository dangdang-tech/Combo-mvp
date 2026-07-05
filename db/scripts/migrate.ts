// 极简 SQL 迁移 runner（B-03）。按文件名字典序执行 migrations/*.sql，记账到 schema_migrations。
// 迁移策略（Daniel 2026-07-04 决策）：0000_baseline_schema.sql 是合并后的基线（原 0000-0018 已删）；
//   之后的变更新增迁移文件（已执行过的文件不可改），历史再度堆积时可再次合并基线——
//   合并时旧库执行 `DELETE FROM schema_migrations; INSERT ... VALUES ('<新基线文件名>')` 重置记账。
// 需 DATABASE_URL（无 Docker，连任意 PG 实例即可）。
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, '..', 'migrations');

function listMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

async function main(): Promise<void> {
  const statusOnly = process.argv.includes('--status');
  const databaseUrl = process.env.DATABASE_URL ?? 'postgres://agora:agora@localhost:5432/agora';
  const files = listMigrations();

  if (statusOnly && !process.env.DATABASE_URL) {
    // 无连接也能列出迁移清单（CI/守门用）。

    console.log('migrations (no DB connection):\n' + files.map((f) => '  - ' + f).join('\n'));
    return;
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    const applied = new Set(
      (await client.query<{ filename: string }>('SELECT filename FROM schema_migrations')).rows.map(
        (r) => r.filename,
      ),
    );

    if (statusOnly) {
      for (const f of files) {
        console.log(`${applied.has(f) ? '[x]' : '[ ]'} ${f}`);
      }
      return;
    }

    for (const f of files) {
      if (applied.has(f)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf-8');

      console.log(`applying ${f} ...`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(filename) VALUES ($1)', [f]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${f} failed: ${(err as Error).message}`);
      }
    }

    console.log('migrations up to date.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
