import { MeshoptSimplifier } from 'meshoptimizer';
import { BufferAttribute, BufferGeometry } from 'three';

export interface SimplifiedGeometry {
  geometry: BufferGeometry;
  triangles: number;
  /** Relative error meshoptimizer reports (fraction of the mesh extent). */
  error: number;
  /** True when the attribute-preserving simplifier stalled and the sloppy one was used. */
  sloppy: boolean;
}

/** Stop the careful simplifier at this deviation; beyond it, fall back to sloppy clustering. */
const MAX_RELATIVE_ERROR = 0.05;

/**
 * Reduces a mesh to about `targetTriangles` by re-indexing its existing vertices (meshoptimizer).
 * No vertex is created or moved, so skin indices/weights, UVs and normals stay valid, and the
 * result shares every vertex attribute with the source: only the index buffer is new
 * (implementation plan §I.4, §17).
 */
export async function simplifyGeometry(
  source: BufferGeometry,
  targetTriangles: number,
): Promise<SimplifiedGeometry> {
  await MeshoptSimplifier.ready;

  const position = source.getAttribute('position');
  const vertexCount = position.count;
  const positions = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    positions[i * 3] = position.getX(i);
    positions[i * 3 + 1] = position.getY(i);
    positions[i * 3 + 2] = position.getZ(i);
  }
  const indices =
    source.index === null
      ? Uint32Array.from({ length: vertexCount }, (_, i) => i)
      : Uint32Array.from(source.index.array);

  const targetIndexCount = Math.max(3, Math.floor(targetTriangles) * 3);
  let sloppy = false;
  let [result, error] =
    indices.length <= targetIndexCount
      ? [indices, 0]
      : MeshoptSimplifier.simplify(indices, positions, 3, targetIndexCount, MAX_RELATIVE_ERROR, [
          'Prune',
        ]);
  // Seams (UV splits, separate parts) can stop the careful pass well short of the target.
  if (result.length > targetIndexCount * 1.5) {
    [result, error] = MeshoptSimplifier.simplifySloppy(
      indices,
      positions,
      3,
      null,
      targetIndexCount,
      MAX_RELATIVE_ERROR * 4,
    );
    sloppy = true;
  }

  const geometry = new BufferGeometry();
  for (const [name, attribute] of Object.entries(source.attributes)) {
    geometry.setAttribute(name, attribute);
  }
  geometry.setIndex(new BufferAttribute(result, 1));
  geometry.name = `${source.name}_${Math.round(result.length / 3)}t`;
  if (source.boundingSphere !== null) geometry.boundingSphere = source.boundingSphere.clone();
  if (source.boundingBox !== null) geometry.boundingBox = source.boundingBox.clone();

  return { geometry, triangles: result.length / 3, error, sloppy };
}
