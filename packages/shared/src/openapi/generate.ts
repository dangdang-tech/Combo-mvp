// CLI：把 OpenAPI 3.1 document 写到 dist/openapi.json（供 web 端 codegen）。
// 运行：pnpm -F @cb/shared openapi:gen
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildOpenApiDocument } from './document.js';

const doc = buildOpenApiDocument();
const outPath = resolve(process.cwd(), 'dist', 'openapi.json');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(doc, null, 2), 'utf-8');

console.log(`OpenAPI 3.1 document written to ${outPath}`);
