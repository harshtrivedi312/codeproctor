import { describe, expect, it } from 'vitest';
import { safeChildPath } from './safe-path.mjs';

describe('safeChildPath (FR-606 self-hosted models, manifest path traversal)', () => {
  it('FR-606: accepts plain shard names and resolves them inside the directory', () => {
    expect(safeChildPath('/tmp/out/coco-ssd', 'group1-shard1of5')).toBe(
      '/tmp/out/coco-ssd/group1-shard1of5',
    );
    expect(safeChildPath('/tmp/out/coco-ssd', 'weights_1.bin')).toBe(
      '/tmp/out/coco-ssd/weights_1.bin',
    );
  });
  it('FR-606: rejects traversal, separators, absolute paths and dot names', () => {
    for (const bad of [
      '../x',
      '..',
      '.',
      'a/b',
      '/etc/passwd',
      'a\\b',
      '',
      'a b',
      '%2e%2e',
      'x\0y',
    ]) {
      expect(() => safeChildPath('/tmp/out/coco-ssd', bad)).toThrow(/Refusing/);
    }
    expect(() => safeChildPath('/tmp/out/coco-ssd', 5)).toThrow(/Refusing/);
  });
});
