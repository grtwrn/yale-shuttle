import { describe, expect, it, vi } from 'vitest';

describe('movement kernel cache', () => {
  it('gives the same bucket the same probabilities regardless of earlier callers', async () => {
    vi.resetModules();
    const first = await import('./filter');
    first.moveKernel(3.21);
    const a = first.moveKernel(3.24);
    vi.resetModules();
    const second = await import('./filter');
    second.moveKernel(3.24);
    const b = second.moveKernel(3.21);
    expect(a).toEqual(b);
  });
});
