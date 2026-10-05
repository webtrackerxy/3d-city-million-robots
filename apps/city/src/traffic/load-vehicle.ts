import type { VehiclePart } from '@city/render';
import {
  type BufferAttribute,
  BufferGeometry,
  Float32BufferAttribute,
  type InterleavedBufferAttribute,
  type Material,
  Mesh,
  Vector3,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

/** The vehicle asset manifest of the 3d-city-million-cars pipeline (the fields used here). */
interface VehicleManifest {
  vehicle: string;
  lods: { id: number; file: string; triangles: number; optimized?: { file: string } }[];
}

export interface VehicleAsset {
  name: string;
  /** Material parts per LOD, best first. */
  lods: VehiclePart[][];
  triangles: number[];
}

let loader: GLTFLoader | null = null;

/**
 * Loads a vehicle's LOD chain (the cars project's Blender-generated Porsche, meshopt-compressed)
 * as instancing-ready parts: node transforms folded into the geometry, one geometry per material,
 * float positions and normals only (WebGPU has no 3-component 8-bit vertex format).
 * The assets are double-sided and some parts are inside-out; each part is made consistent (winding
 * along the normals) and turned outward (positive volume), so the cars render single-sided and
 * light correctly.
 */
export async function loadVehicle(base: string): Promise<VehicleAsset> {
  const response = await fetch(`${base}/manifest.json`);
  if (!response.ok) throw new Error(`${base}/manifest.json: HTTP ${response.status}`);
  const manifest = (await response.json()) as VehicleManifest;
  if (loader === null) {
    loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
  }
  const gltfLoader = loader;
  const lods = await Promise.all(
    [...manifest.lods]
      .sort((a, b) => a.id - b.id)
      .map(async (lod) => {
        const gltf = await gltfLoader.loadAsync(`${base}/${lod.optimized?.file ?? lod.file}`);
        gltf.scene.updateMatrixWorld(true);
        const parts: VehiclePart[] = [];
        gltf.scene.traverse((node) => {
          if (!(node instanceof Mesh)) return;
          const mesh = node as Mesh<BufferGeometry, Material>;
          const geometry = new BufferGeometry();
          geometry.setAttribute('position', toFloat(mesh.geometry.getAttribute('position')));
          const normal = mesh.geometry.getAttribute('normal') as
            BufferAttribute | InterleavedBufferAttribute | undefined;
          if (normal !== undefined) geometry.setAttribute('normal', toFloat(normal));
          const index = mesh.geometry.getIndex();
          if (index !== null) geometry.setIndex(Array.from(index.array));
          geometry.applyMatrix4(mesh.matrixWorld);
          if (normal === undefined) geometry.computeVertexNormals();
          else windWithNormals(geometry);
          parts.push({
            material: mesh.material.name || 'unnamed',
            geometry,
            source: mesh.material,
          });
        });
        return parts;
      }),
  );
  return {
    name: manifest.vehicle,
    lods,
    triangles: lods.map((parts) =>
      parts.reduce(
        (n, p) => n + (p.geometry.index?.count ?? p.geometry.getAttribute('position').count) / 3,
        0,
      ),
    ),
  };
}

/** Any (quantised, normalised or interleaved) attribute as plain float32. */
function toFloat(attribute: BufferAttribute | InterleavedBufferAttribute): Float32BufferAttribute {
  const size = attribute.itemSize;
  const out = new Float32Array(attribute.count * size);
  for (let i = 0; i < attribute.count; i++)
    for (let c = 0; c < size; c++) out[i * size + c] = attribute.getComponent(i, c);
  return new Float32BufferAttribute(out, size);
}

/**
 * Flips every triangle whose winding disagrees with its vertices' normals, then turns the whole
 * part outward if it encloses negative volume (inside-out).
 */
function windWithNormals(geometry: BufferGeometry): void {
  const index = geometry.getIndex();
  if (index === null) return;
  const p = geometry.getAttribute('position').array as Float32Array;
  const n = geometry.getAttribute('normal').array as Float32Array;
  const ids = index.array;
  for (let t = 0; t + 2 < ids.length; t += 3) {
    const a = ids[t] * 3;
    const b = ids[t + 1] * 3;
    const c = ids[t + 2] * 3;
    const ux = p[b] - p[a];
    const uy = p[b + 1] - p[a + 1];
    const uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a];
    const vy = p[c + 1] - p[a + 1];
    const vz = p[c + 2] - p[a + 2];
    const fx = uy * vz - uz * vy;
    const fy = uz * vx - ux * vz;
    const fz = ux * vy - uy * vx;
    const nx = n[a] + n[b] + n[c];
    const ny = n[a + 1] + n[b + 1] + n[c + 1];
    const nz = n[a + 2] + n[b + 2] + n[c + 2];
    if (fx * nx + fy * ny + fz * nz < 0) {
      const swap = ids[t + 1];
      ids[t + 1] = ids[t + 2];
      ids[t + 2] = swap;
    }
  }
  // Signed volume about the part's centre: negative when the surface faces inward.
  geometry.computeBoundingBox();
  const centre = geometry.boundingBox?.getCenter(new Vector3()) ?? new Vector3();
  let volume = 0;
  for (let t = 0; t + 2 < ids.length; t += 3) {
    const a = ids[t] * 3;
    const b = ids[t + 1] * 3;
    const c = ids[t + 2] * 3;
    const ax = p[a] - centre.x;
    const ay = p[a + 1] - centre.y;
    const az = p[a + 2] - centre.z;
    const bx = p[b] - centre.x;
    const by = p[b + 1] - centre.y;
    const bz = p[b + 2] - centre.z;
    const cx = p[c] - centre.x;
    const cy = p[c + 1] - centre.y;
    const cz = p[c + 2] - centre.z;
    volume += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  if (volume >= 0) return;
  for (let t = 0; t + 2 < ids.length; t += 3) {
    const swap = ids[t + 1];
    ids[t + 1] = ids[t + 2];
    ids[t + 2] = swap;
  }
  for (let i = 0; i < n.length; i++) n[i] = -n[i];
}
