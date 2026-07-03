import { describe, expect, it } from 'vitest';
import {
  CREATOR_CAPABILITIES_PATH,
  appendRuntimeReturnTo,
  readRuntimeReturnTo,
  rememberRuntimeReturnTo,
  runtimeBackLabel,
  runtimeBackTarget,
  safeRuntimeReturnTo,
} from './runtimeReturn.js';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe('runtime return navigation', () => {
  it('accepts only same-origin relative return paths', () => {
    expect(safeRuntimeReturnTo('/create/capabilities?snapshotId=s1&draftId=d1#picked')).toBe(
      '/create/capabilities?snapshotId=s1&draftId=d1#picked',
    );
    expect(safeRuntimeReturnTo('/capabilities')).toBe('/capabilities');
    expect(safeRuntimeReturnTo('https://example.com/create/capabilities')).toBeNull();
    expect(safeRuntimeReturnTo('//example.com/create/capabilities')).toBeNull();
    expect(safeRuntimeReturnTo('create/capabilities')).toBeNull();
    expect(safeRuntimeReturnTo('/create/capabilities\u0000')).toBeNull();
  });

  it('stores and restores returnTo by runtime session id', () => {
    const storage = new MemoryStorage();

    rememberRuntimeReturnTo('trial-1', '/create/capabilities?snapshotId=s1&draftId=d1', storage);
    rememberRuntimeReturnTo('trial-2', '//example.com/phish', storage);

    expect(readRuntimeReturnTo('trial-1', storage)).toBe(
      '/create/capabilities?snapshotId=s1&draftId=d1',
    );
    expect(readRuntimeReturnTo('trial-2', storage)).toBeNull();
    expect(readRuntimeReturnTo('missing', storage)).toBeNull();
  });

  it('keeps returnTo when navigating between runtime sessions', () => {
    expect(
      appendRuntimeReturnTo('/session/consume-1', '/create/capabilities?snapshotId=s1&draftId=d1'),
    ).toBe('/session/consume-1?returnTo=%2Fcreate%2Fcapabilities%3FsnapshotId%3Ds1%26draftId%3Dd1');
    expect(appendRuntimeReturnTo('/session/consume-1?panel=timeline', '/capabilities')).toBe(
      '/session/consume-1?panel=timeline&returnTo=%2Fcapabilities',
    );
    expect(appendRuntimeReturnTo('/session/consume-1', 'https://example.com')).toBe(
      '/session/consume-1',
    );
  });

  it('uses publish page wording and fallback creator target', () => {
    const returnTo = '/create/capabilities?snapshotId=s1&draftId=d1';

    expect(runtimeBackLabel(returnTo)).toBe('← 返回发布页');
    expect(runtimeBackTarget(returnTo)).toBe(returnTo);
    expect(runtimeBackLabel(null)).toBe('← 返回我的能力');
    expect(runtimeBackTarget(null)).toBe(CREATOR_CAPABILITIES_PATH);
  });
});
