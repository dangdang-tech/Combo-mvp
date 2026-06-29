// 导出 OpenAPI 3.1 document 到 stdout（O-05）。供 web codegen / 文档站。
import { buildOpenApiDocument } from '@cb/shared';

const doc = buildOpenApiDocument();
process.stdout.write(JSON.stringify(doc, null, 2) + '\n');
