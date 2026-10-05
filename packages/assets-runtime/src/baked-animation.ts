/**
 * Baked skinning animation for one skeleton family (implementation plan §6, §8).
 *
 * `matrices` holds, for every clip back to back, `frameCount × boneCount` skinning matrices in
 * character-root space. Each matrix is the top three rows of the 4×4 transform, stored row-major
 * as three vec4<f32> (48 B), so a shader transforms a point with three dot products:
 *
 *   p' = (dot(r0, p), dot(r1, p), dot(r2, p))   with p.w = 1
 *
 * Matrix index = (clip.firstFrame + frame) * boneCount + bone.
 */
export const BONE_MATRIX_FLOATS = 12;
export const BONE_MATRIX_BYTES = BONE_MATRIX_FLOATS * 4;

/**
 * Clip table record, bound as a WGSL storage array (24 B stride, 4-byte aligned).
 *
 *   offset  type  field
 *   0       u32   firstFrame    first frame of the clip in the matrix buffer
 *   4       u32   frameCount
 *   8       f32   fps           frames per second of *this* clip (frameCount spans duration exactly)
 *   12      f32   strideLength  metres travelled per cycle, 0 for in-place clips
 *   16      f32   duration      seconds
 *   20      u32   flags         ClipFlag bits
 */
export const CLIP_RECORD_BYTES = 24;

export const ClipRecordOffset = {
  FirstFrame: 0,
  FrameCount: 4,
  Fps: 8,
  StrideLength: 12,
  Duration: 16,
  Flags: 20,
} as const;

export const ClipFlag = {
  /**
   * Cycle clip: the frame after the last is frame 0 again, and the seam pose is stored once.
   * Without it the clip plays once and holds its final frame, which is stored.
   */
  Loop: 1 << 0,
} as const;

export interface BakedClip {
  name: string;
  firstFrame: number;
  frameCount: number;
  fps: number;
  strideLength: number;
  duration: number;
  flags: number;
}

export interface BakedAnimation {
  boneCount: number;
  boneNames: readonly string[];
  /**
   * Each bone's origin in the mesh's bind space (xyz per bone). Skinning a pivot with its own
   * bone's matrix gives that bone's animated position in root space.
   */
  bonePivots: Float32Array<ArrayBuffer>;
  clips: readonly BakedClip[];
  matrices: Float32Array<ArrayBuffer>;
}

export function totalFrames(clips: readonly BakedClip[]): number {
  return clips.reduce((sum, clip) => sum + clip.frameCount, 0);
}

export function findClipIndex(baked: BakedAnimation, name: string): number {
  const index = baked.clips.findIndex((clip) => clip.name === name);
  if (index < 0) throw new Error(`No baked clip named "${name}"`);
  return index;
}

export function packClipTable(clips: readonly BakedClip[]): ArrayBuffer {
  const buffer = new ArrayBuffer(Math.max(1, clips.length) * CLIP_RECORD_BYTES);
  const view = new DataView(buffer);
  clips.forEach((clip, index) => {
    const base = index * CLIP_RECORD_BYTES;
    view.setUint32(base + ClipRecordOffset.FirstFrame, clip.firstFrame, true);
    view.setUint32(base + ClipRecordOffset.FrameCount, clip.frameCount, true);
    view.setFloat32(base + ClipRecordOffset.Fps, clip.fps, true);
    view.setFloat32(base + ClipRecordOffset.StrideLength, clip.strideLength, true);
    view.setFloat32(base + ClipRecordOffset.Duration, clip.duration, true);
    view.setUint32(base + ClipRecordOffset.Flags, clip.flags, true);
  });
  return buffer;
}

/** Inverse of packClipTable, minus names. f32 fields come back at f32 precision. */
export function unpackClipTable(buffer: ArrayBuffer): Omit<BakedClip, 'name'>[] {
  const view = new DataView(buffer);
  const count = Math.floor(buffer.byteLength / CLIP_RECORD_BYTES);
  const clips: Omit<BakedClip, 'name'>[] = [];
  for (let index = 0; index < count; index++) {
    const base = index * CLIP_RECORD_BYTES;
    clips.push({
      firstFrame: view.getUint32(base + ClipRecordOffset.FirstFrame, true),
      frameCount: view.getUint32(base + ClipRecordOffset.FrameCount, true),
      fps: view.getFloat32(base + ClipRecordOffset.Fps, true),
      strideLength: view.getFloat32(base + ClipRecordOffset.StrideLength, true),
      duration: view.getFloat32(base + ClipRecordOffset.Duration, true),
      flags: view.getUint32(base + ClipRecordOffset.Flags, true),
    });
  }
  return clips;
}
