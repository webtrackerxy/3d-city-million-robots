import { simplifyGeometry } from '@city/assets-runtime';
import { MESH_LOD_COUNT } from '@city/core-types';
import type { BufferGeometry } from 'three';
import type { CharacterSource } from './load-character.ts';

export interface LodChain {
  /** geometries[lod][subMesh]; every LOD shares the source vertex buffers and skin. */
  geometries: BufferGeometry[][];
  /** Triangles per character at each LOD, summed over sub-meshes. */
  triangles: number[];
}

/**
 * Stand-in for the Blender LOD workflow (§5) until authored LODs exist: each LOD is simplified
 * from the previous one (gentler steps than always starting from LOD0), with each sub-mesh keeping
 * its share of the §17 triangle target for its family. Meshes already below a target are reused as they are.
 */
export async function buildLodChain(
  character: CharacterSource,
  targets: readonly number[],
): Promise<LodChain> {
  const sources = character.meshes.map((mesh) => mesh.geometry);
  const totalTriangles = sources.reduce((sum, geometry) => sum + triangleCount(geometry), 0);

  const geometries: BufferGeometry[][] = [];
  const triangles: number[] = [];
  let previous = sources;
  for (let lod = 0; lod < MESH_LOD_COUNT; lod++) {
    const target = Math.min(targets[lod] ?? 0, totalTriangles);
    const level: BufferGeometry[] = [];
    let levelTriangles = 0;
    for (const [index, geometry] of previous.entries()) {
      const share = triangleCount(sources[index] ?? geometry) / totalTriangles;
      const simplified = await simplifyGeometry(geometry, Math.max(4, target * share));
      level.push(simplified.geometry);
      levelTriangles += simplified.triangles;
    }
    geometries.push(level);
    triangles.push(levelTriangles);
    previous = level;
  }
  return { geometries, triangles };
}

function triangleCount(geometry: BufferGeometry): number {
  return (geometry.index?.count ?? geometry.getAttribute('position').count) / 3;
}
