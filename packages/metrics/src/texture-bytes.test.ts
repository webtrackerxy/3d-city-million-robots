import { describe, expect, it } from 'vitest';
import { estimateTextureBytes, texelBlockOf } from './texture-bytes.ts';

describe('texelBlockOf', () => {
  it.each([
    ['r8unorm', 1],
    ['rg8unorm', 2],
    ['rgba8unorm-srgb', 4],
    ['bgra8unorm', 4],
    ['r16float', 2],
    ['rgba16float', 8],
    ['rgba32float', 16],
    ['r32uint', 4],
    ['depth24plus', 4],
    ['depth32float-stencil8', 5],
    ['rg11b10ufloat', 4],
  ])('%s is %d bytes per texel', (format, bytes) => {
    expect(texelBlockOf(format)).toEqual({ width: 1, height: 1, bytes });
  });

  it('knows block-compressed formats', () => {
    expect(texelBlockOf('bc1-rgba-unorm')).toEqual({ width: 4, height: 4, bytes: 8 });
    expect(texelBlockOf('bc7-rgba-unorm-srgb')).toEqual({ width: 4, height: 4, bytes: 16 });
    expect(texelBlockOf('etc2-rgba8unorm')).toEqual({ width: 4, height: 4, bytes: 16 });
    expect(texelBlockOf('astc-8x6-unorm')).toEqual({ width: 8, height: 6, bytes: 16 });
  });
});

describe('estimateTextureBytes', () => {
  const usage = 0;

  it('handles array and dictionary extents', () => {
    expect(estimateTextureBytes({ size: [256, 128], format: 'rgba8unorm', usage })).toBe(
      256 * 128 * 4,
    );
    expect(
      estimateTextureBytes({
        size: { width: 64, height: 64, depthOrArrayLayers: 8 },
        format: 'rgba8unorm',
        usage,
      }),
    ).toBe(64 * 64 * 4 * 8);
  });

  it('sums the mip chain', () => {
    // 4x4 + 2x2 + 1x1 texels
    expect(estimateTextureBytes({ size: [4, 4], format: 'r8unorm', mipLevelCount: 3, usage })).toBe(
      21,
    );
  });

  it('matches the plan estimate for a 2k BC7 texture with mips (~5.3 MB)', () => {
    const bytes = estimateTextureBytes({
      size: [2048, 2048],
      format: 'bc7-rgba-unorm',
      mipLevelCount: 12,
      usage,
    });
    expect(bytes / 2 ** 20).toBeGreaterThan(5.3);
    expect(bytes / 2 ** 20).toBeLessThan(5.4);
  });

  it('shrinks depth for 3d textures but not layers for 2d arrays', () => {
    const size = [4, 4, 4];
    expect(
      estimateTextureBytes({ size, format: 'r8unorm', mipLevelCount: 2, dimension: '3d', usage }),
    ).toBe(64 + 8);
    expect(estimateTextureBytes({ size, format: 'r8unorm', mipLevelCount: 2, usage })).toBe(
      64 + 16,
    );
  });

  it('multiplies by the MSAA sample count', () => {
    expect(
      estimateTextureBytes({ size: [16, 16], format: 'bgra8unorm', sampleCount: 4, usage }),
    ).toBe(16 * 16 * 4 * 4);
  });
});
