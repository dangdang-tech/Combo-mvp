// OpenAPI 3.1 文档生成（B-07）。从注册表产出完整 document，供 web 端 codegen。
import { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import type { OpenAPIObject } from 'openapi3-ts/oas31';
import { registerSchemas } from './registry.js';
import { API_PREFIX } from '../constants/routes.js';

export interface BuildOpenApiOptions {
  title?: string;
  version?: string;
  serverUrl?: string;
}

/** 构建 OpenAPI 3.1 document 对象（components/schemas 来自注册表）。 */
export function buildOpenApiDocument(opts: BuildOpenApiOptions = {}): OpenAPIObject {
  const reg = registerSchemas();
  const generator = new OpenApiGeneratorV31(reg.definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: opts.title ?? '创作者中心主链路 API',
      version: opts.version ?? '0.0.0',
      description:
        'zod schema 即 OpenAPI 3.1 真源（脊柱 §1.1 B-07）。本期为骨架：components/schemas 全量、路径 Phase 3 补。',
    },
    servers: [{ url: opts.serverUrl ?? API_PREFIX }],
  });
}
