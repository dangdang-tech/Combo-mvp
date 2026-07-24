import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');
const DEPLOY_FILE = resolve(ROOT, 'scripts/deploy-release.sh');
const DEPLOY = readFileSync(DEPLOY_FILE, 'utf8');

function indexOf(pattern, label = String(pattern)) {
  const match = DEPLOY.match(pattern);
  assert.ok(match, `deploy-release.sh must contain ${label}`);
  return match.index;
}

function assertBefore(first, second, message) {
  const firstIndex = typeof first === 'number' ? first : indexOf(first);
  const secondIndex = typeof second === 'number' ? second : indexOf(second);
  assert.ok(firstIndex < secondIndex, message);
}

function functionBody(name) {
  const start = indexOf(new RegExp(`(?:^|\\n)${name}\\(\\)\\s*\\{`), `${name}()`);
  const nextFunction = DEPLOY.slice(start + 1).search(/\n[a-zA-Z_][a-zA-Z0-9_]*\(\)\s*\{/);
  return nextFunction < 0 ? DEPLOY.slice(start) : DEPLOY.slice(start, start + 1 + nextFunction);
}

function environmentArm(name) {
  const environmentCase = DEPLOY.slice(indexOf(/case "\$ENVIRONMENT" in/, 'environment dispatch'));
  const match = environmentCase.match(new RegExp(`${name}\\)([\\s\\S]*?);;`));
  assert.ok(match, `deploy-release.sh must define the ${name} environment`);
  return match[1];
}

test('fresh deploy exposes only the disposable-data interface for Preview and Production', () => {
  for (const option of [
    '--environment',
    '--fresh-reset',
    '--manifest',
    '--manifest-digest',
    '--migrations',
    '--foundation-yaml',
    '--init-yaml',
    '--migrate-yaml',
    '--apps-yaml',
    '--web-assets',
  ]) {
    assert.match(DEPLOY, new RegExp(option.replaceAll('-', '\\-')));
  }

  const preview = environmentArm('preview');
  const production = environmentArm('production');
  assert.match(preview, /NAMESPACE=combo-review/);
  assert.match(production, /NAMESPACE=combo(?:\s|$)/);
  for (const [name, arm] of [
    ['Preview', preview],
    ['Production', production],
  ]) {
    assert.match(arm, /FOUNDATION_YAML/);
    assert.match(arm, /INIT_YAML/);
    assert.match(arm, /requires/i, `${name} must require foundation and init manifests`);
    assert.doesNotMatch(
      arm,
      /\[\[\s+-z\s+"\$(?:FOUNDATION_YAML|INIT_YAML)"/,
      `${name} must not reuse a legacy foundation`,
    );
  }
  assert.match(DEPLOY, /FRESH_RESET[\s\S]*required|requires[\s\S]*--fresh-reset/i);

  assert.doesNotMatch(
    DEPLOY,
    /\bbackup\b|backup[-_]|cosfs|\/lhcos-data|offhost|pg_restore|isolated.{0,20}restore/i,
  );
});

test('all local and server-side validation gates precede the first fresh reset mutation', () => {
  const reset = indexOf(
    /\n[ \t]*fresh_reset_release_data(?:\s|$)/,
    'fresh_reset_release_data call',
  );

  for (const [pattern, label] of [
    [/release-manifest\.mjs["']?\s+verify/, 'release manifest digest verification'],
    [/web-asset-manifest\.mjs["']?\s+verify/, 'Web asset manifest digest verification'],
    [/validate_migrations(?:\s|$)/, 'migration list validation'],
    [/secret_has_key(?:\s|$)/, 'Secret key-only validation'],
    [/validate_rendered_phase\s+foundation/, 'foundation server dry-run verification'],
    [/validate_rendered_phase\s+init/, 'init server dry-run verification'],
    [/validate_rendered_phase\s+migrate/, 'migration server dry-run verification'],
    [/validate_rendered_phase\s+apps/, 'application server dry-run verification'],
  ]) {
    assertBefore(indexOf(pattern, label), reset, `${label} must finish before fresh reset`);
  }

  assert.match(
    DEPLOY,
    /get secret "\$secret"[\s\\\n]*-o ['"]go-template=/,
    'Secret inspection must request key names through a Go template',
  );
  assert.doesNotMatch(
    DEPLOY,
    /get secret[^\n]*(?:-o|--output)[ =]?(?:json|yaml|jsonpath)/,
    'Secret values must never be fetched as JSON, YAML, or jsonpath',
  );
});

test('fresh reset is constrained to an exact workload and PVC allowlist', () => {
  const reset = functionBody('fresh_reset_release_data');

  for (const workload of [
    'release-postgres',
    'release-redis-queue',
    'release-redis-hot',
    'release-minio',
    'api',
    'worker',
    'runtime',
    'web',
  ]) {
    assert.ok(reset.includes(workload), `fresh reset allowlist must name ${workload}`);
  }
  for (const claim of [
    'data-release-postgres-0',
    'data-release-redis-queue-0',
    'data-release-minio-0',
  ]) {
    assert.ok(reset.includes(claim), `fresh reset PVC allowlist must name ${claim}`);
  }

  assert.match(reset, /kubectl|\$\{?K\[@\]\}?/);
  assert.match(reset, /\bdelete\b/);
  assert.doesNotMatch(reset, /\bdelete\s+(?:namespace|ns)\b/);
  assert.doesNotMatch(reset, /\bdelete\s+secret\b/);
  assert.doesNotMatch(reset, /--all\b|\ball\b.*(?:deployment|statefulset|pvc)/i);
});

test('migration is a hard fence before applications, traffic, and legacy cleanup', () => {
  const reset = indexOf(/\n[ \t]*fresh_reset_release_data(?:\s|$)/, 'fresh reset call');
  const foundation = indexOf(/\n[ \t]*apply_foundation(?:\s|$)/, 'apply_foundation call');
  const migration = indexOf(/\n[ \t]*run_migration(?:\s|$)/, 'run_migration call');
  const apps = indexOf(/\n[ \t]*apply_apps(?:\s|$)/, 'apply_apps call');
  const traffic = indexOf(/\n[ \t]*switch_release_traffic(?:\s|$)/, 'switch_release_traffic call');
  const cleanup = indexOf(/\n[ \t]*cleanup_legacy(?:\s|$)/, 'cleanup_legacy call');

  assert.ok(reset < foundation, 'fresh data must be cleared before foundation creation');
  assert.ok(foundation < migration, 'foundation and bucket init must finish before migration');
  assert.ok(migration < apps, 'migration must finish before business manifests');
  assert.ok(apps < traffic, 'business verification must finish before traffic cutover');
  assert.ok(traffic < cleanup, 'legacy resources must survive until traffic cutover succeeds');

  const migrationBody = functionBody('run_migration');
  assert.match(migrationBody, /if\s+!\s+[\s\S]*\bwait\b|[\s\S]*\bwait\b[\s\S]*\|\|\s+fail/);
  assert.match(migrationBody, /fail ['"][^'"]*migration/i);
  assert.doesNotMatch(migrationBody, /\bapply_apps\b|APPS_YAML/);

  assert.match(
    functionBody('switch_release_traffic'),
    /"\$SCRIPT_DIR\/switch-release-traffic\.sh"/,
  );
});

test('a completed evidence checkpoint returns before every cluster mutation', () => {
  const evidenceCheck = indexOf(
    /\n[ \t]*(?:verify_completed_release|completed_release_exists|reuse_completed_release)(?:\s|$)/,
    'completed release evidence check',
  );
  const reset = indexOf(/\n[ \t]*fresh_reset_release_data(?:\s|$)/, 'fresh reset call');
  const between = DEPLOY.slice(evidenceCheck, reset);

  assert.match(between, /\bexit 0\b|\breturn 0\b/);
  assert.doesNotMatch(between, /\b(?:apply|delete|patch|replace|scale)\b/);
});

test('legacy cleanup runs only after traffic evidence and names only legacy resources', () => {
  const cleanup = functionBody('cleanup_legacy');

  for (const workload of [
    'postgres',
    'redis-queue',
    'redis-hot',
    'minio',
    'api',
    'consumer',
    'runtime',
    'sweeper',
    'web',
    'worker',
  ]) {
    assert.ok(cleanup.includes(workload), `legacy cleanup allowlist must name ${workload}`);
  }
  for (const claim of ['data-postgres-0', 'data-redis-queue-0', 'data-minio-0']) {
    assert.ok(cleanup.includes(claim), `legacy cleanup PVC allowlist must name ${claim}`);
  }

  assert.doesNotMatch(cleanup, /\bdelete\s+(?:namespace|ns|secret)\b/);
  assert.doesNotMatch(cleanup, /--all\b/);
});
