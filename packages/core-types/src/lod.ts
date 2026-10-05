/**
 * Render LOD ids shared by the asset pipeline, the GPU LOD-selection pass and the debug UI.
 * Plain const object rather than an enum so the package stays erasable-syntax only.
 */
export const RenderLod = {
  Lod0: 0,
  Lod1: 1,
  Lod2: 2,
  Lod3: 3,
  Lod4: 4,
  Impostor: 5,
  Point: 6,
} as const;

export type RenderLod = (typeof RenderLod)[keyof typeof RenderLod];

export const RENDER_LOD_COUNT = 7;

/** Number of LODs that are real skinned meshes (Lod0..Lod4). */
export const MESH_LOD_COUNT = 5;

/** Linear RGB debug colours, indexed by RenderLod. */
export const RENDER_LOD_DEBUG_COLOURS: readonly (readonly [number, number, number])[] = [
  [1.0, 0.1, 0.1], // Lod0 red
  [1.0, 0.5, 0.0], // Lod1 orange
  [1.0, 0.9, 0.1], // Lod2 yellow
  [0.1, 0.8, 0.2], // Lod3 green
  [0.1, 0.4, 1.0], // Lod4 blue
  [1.0, 0.1, 0.9], // Impostor magenta
  [1.0, 1.0, 1.0], // Point white
];
