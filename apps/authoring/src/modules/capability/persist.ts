// 云端与本地提取共用的能力定义持久化缝：同一 Schema、对象键、capabilities 行和 item view。
import { randomUUID } from 'node:crypto';
import {
  CapabilityDefinitionSchema,
  type CapabilityDefinition,
  type CapabilityView,
  type ObjectStorePort,
} from '@cb/shared';
import type { Queryable } from '../../platform/infra/db.js';
import { insertCapability } from './repo.js';

/** 能力项可运行定义所在桶（长期保留，与会被清除的原始件分桶）。 */
export const CAPABILITY_BUCKET = 'combo-artifacts' as const;

/** 能力项定义对象键。 */
export function capabilityDefinitionKey(capabilityId: string): string {
  return `capabilities/${capabilityId}/definition.json`;
}

export interface PersistCapabilityItem {
  id?: string;
  definition: CapabilityDefinition;
  /** capabilities.meta 的服务端索引元信息，不改变 definition JSON 契约。 */
  indexMeta?: Record<string, unknown>;
}

export async function persistCapabilityDefinitions(
  deps: { db: Queryable; objectStore: ObjectStorePort },
  input: {
    taskId: string;
    ownerUserId: string;
    items: PersistCapabilityItem[];
    onPersisted?: (view: CapabilityView, index: number, total: number) => Promise<void>;
  },
): Promise<CapabilityView[]> {
  const views: CapabilityView[] = [];
  for (const [index, item] of input.items.entries()) {
    const capabilityId = item.id ?? randomUUID();
    const definition = CapabilityDefinitionSchema.parse(item.definition);
    const storageKey = capabilityDefinitionKey(capabilityId);
    await deps.objectStore.putObject(
      CAPABILITY_BUCKET,
      storageKey,
      new TextEncoder().encode(JSON.stringify(definition)),
      { contentType: 'application/json' },
    );
    const view = await insertCapability(deps.db, {
      id: capabilityId,
      taskId: input.taskId,
      ownerUserId: input.ownerUserId,
      name: definition.name,
      summary: definition.summary,
      kind: definition.kind,
      storageKey,
      meta: item.indexMeta ?? definition.meta,
    });
    views.push(view);
    await input.onPersisted?.(view, index, input.items.length);
  }
  return views;
}
