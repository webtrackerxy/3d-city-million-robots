/**
 * Rigs a static humanoid model (e.g. the Tesla Optimus GLB, one mesh, no skeleton) to the Mixamo
 * skeleton and clips of another model (Xbot), so the crowd can bake and play its walk:
 *
 *   yarn workspace @city/auto-rig rig --mesh "data/Tesla optimus.glb" \
 *     --skeleton apps/city/public/models/Xbot.glb --out apps/city/public/models/optimus.glb
 *
 * 1. The mesh is turned to face +Z (toes forward) and scaled onto the skeleton's body height.
 * 2. The skeleton's arms are posed to the mesh's (Optimus stands arms down, Xbot binds in a
 *    T-pose); the new bind pose gives the inverse bind matrices. Clips set absolute joint
 *    rotations, so they play unchanged.
 * 3. Skinning: the mesh is split into connected parts. A small part (a plate, a finger segment)
 *    follows one bone — the one most of its vertices are nearest — so it moves rigidly, as a
 *    robot's parts do. A large part (a leg shell) is skinned per vertex to the nearest bone
 *    capsule, blended with an adjacent bone near joints, restricted to the bones the part mostly
 *    touches and to its own side of the body.
 */
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- glTF JSON is read untyped */
import { readFileSync, writeFileSync } from 'node:fs';
import { Matrix3, Matrix4, Quaternion, Vector3 } from 'three';
import { type Glb, GlbWriter, type GltfJson, readAccessor, readGlb } from './glb.ts';

const argument = (name: string, fallback?: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  if (value === undefined) throw new Error(`--${name} is required`);
  return value;
};
const mesh = readGlb(readFileSync(argument('mesh')));
const rig = readGlb(readFileSync(argument('skeleton')));
const out = argument('out');
const clips = argument('clips', 'idle,walk,run').split(',');
const prefix = argument('prefix', 'mixamorig:');

// --- Skeleton: node matrices, parents, world transforms -----------------------------------------

const nodes: GltfJson[] = structuredClone(rig.json.nodes);
const parentOf = new Int32Array(nodes.length).fill(-1);
nodes.forEach((node, i) => {
  for (const child of (node.children ?? []) as number[]) parentOf[child] = i;
});
const localOf = (i: number): Matrix4 => {
  const node = nodes[i];
  if (node.matrix !== undefined) return new Matrix4().fromArray(node.matrix);
  return new Matrix4().compose(
    new Vector3(...((node.translation ?? [0, 0, 0]) as [number, number, number])),
    new Quaternion(...((node.rotation ?? [0, 0, 0, 1]) as [number, number, number, number])),
    new Vector3(...((node.scale ?? [1, 1, 1]) as [number, number, number])),
  );
};
const worldOf = (i: number): Matrix4 =>
  parentOf[i] < 0 ? localOf(i) : worldOf(parentOf[i]).multiply(localOf(i));
const byName = new Map<string, number>(nodes.map((n, i) => [n.name as string, i]));
const joint = (name: string): number => {
  const i = byName.get(prefix + name);
  if (i === undefined) throw new Error(`Skeleton has no ${prefix}${name}`);
  return i;
};
const positionOf = (i: number) => new Vector3().setFromMatrixPosition(worldOf(i));
const skin = rig.json.skins[0];
const joints = skin.joints as number[];

// The skeleton model's body in bind space: vertex = jointWorld · inverseBind · v (any joint).
const ibm0 = new Matrix4().fromArray(
  Array.from(readAccessor(rig, skin.inverseBindMatrices as number).values.subarray(0, 16)),
);
const bindToWorld = worldOf(joints[0] ?? 0).multiply(ibm0);
const body = {
  min: new Vector3(Infinity, Infinity, Infinity),
  max: new Vector3(-Infinity, -Infinity, -Infinity),
};
rig.json.nodes.forEach((node: GltfJson) => {
  if (node.skin === undefined || node.mesh === undefined) return;
  for (const primitive of rig.json.meshes[node.mesh].primitives) {
    const p = readAccessor(rig, primitive.attributes.POSITION as number).values;
    for (let i = 0; i < p.length; i += 3) {
      const v = new Vector3(p[i], p[i + 1], p[i + 2]).applyMatrix4(bindToWorld);
      body.min.min(v);
      body.max.max(v);
    }
  }
});
const height = body.max.y - body.min.y;

// --- The mesh: all primitives in one vertex space, turned and scaled onto the body --------------

interface Part {
  material: number | undefined;
  position: Float32Array;
  normal: Float32Array | null;
  uv: Float32Array | null;
  indices: Uint32Array;
  first: number;
  /** A rigged source: each vertex's 4 joints (source skin node indices) and weights. */
  skin: { joints: Float64Array; weights: Float64Array; nodes: number[] } | null;
}
const parts: Part[] = [];
let vertexCount = 0;
// Every mesh node, with its world transform (Sketchfab exports nest them under axis-fixing roots).
const meshParent = new Int32Array(mesh.json.nodes.length).fill(-1);
(mesh.json.nodes as GltfJson[]).forEach((node, i) => {
  for (const child of (node.children ?? []) as number[]) meshParent[child] = i;
});
const meshLocal = (node: GltfJson): Matrix4 =>
  node.matrix !== undefined
    ? new Matrix4().fromArray(node.matrix)
    : new Matrix4().compose(
        new Vector3(...((node.translation ?? [0, 0, 0]) as [number, number, number])),
        new Quaternion(...((node.rotation ?? [0, 0, 0, 1]) as [number, number, number, number])),
        new Vector3(...((node.scale ?? [1, 1, 1]) as [number, number, number])),
      );
const meshWorldOf = (i: number): Matrix4 =>
  meshParent[i] < 0
    ? meshLocal(mesh.json.nodes[i])
    : meshWorldOf(meshParent[i]).multiply(meshLocal(mesh.json.nodes[i]));
const all: number[] = [];
(mesh.json.nodes as GltfJson[]).forEach((node, n) => {
  if (node.mesh === undefined) return;
  // A skinned mesh's own transform is ignored (glTF): its rest pose is jointWorld · inverseBind.
  let world = meshWorldOf(n);
  if (node.skin !== undefined) {
    const skinDef = mesh.json.skins[node.skin];
    const firstJoint = (skinDef.joints as number[])[0] ?? 0;
    const inverseBind =
      skinDef.inverseBindMatrices === undefined
        ? new Matrix4()
        : new Matrix4().fromArray(
            Array.from(
              readAccessor(mesh, skinDef.inverseBindMatrices as number).values.subarray(0, 16),
            ),
          );
    world = meshWorldOf(firstJoint).multiply(inverseBind);
  }
  const normalMatrix = new Matrix3().getNormalMatrix(world);
  for (const primitive of mesh.json.meshes[node.mesh].primitives) {
    const read = (index: number | undefined) =>
      index === undefined ? null : Float32Array.from(readAccessor(mesh, index).values);
    const position = read(primitive.attributes.POSITION as number) ?? new Float32Array(0);
    const normal = read(primitive.attributes.NORMAL as number | undefined);
    const count = position.length / 3;
    const v = new Vector3();
    for (let i = 0; i < count; i++) {
      v.fromArray(position, i * 3).applyMatrix4(world);
      all.push(v.x, v.y, v.z);
      if (normal !== null) {
        v.fromArray(normal, i * 3)
          .applyMatrix3(normalMatrix)
          .normalize();
        v.toArray(normal, i * 3);
      }
    }
    const skinJoints = primitive.attributes.JOINTS_0 as number | undefined;
    const skinWeights = primitive.attributes.WEIGHTS_0 as number | undefined;
    parts.push({
      material: primitive.material as number | undefined,
      skin:
        node.skin === undefined || skinJoints === undefined || skinWeights === undefined
          ? null
          : {
              joints: readAccessor(mesh, skinJoints).values,
              weights: readAccessor(mesh, skinWeights).values,
              nodes: mesh.json.skins[node.skin].joints as number[],
            },
      position,
      normal,
      uv: read(primitive.attributes.TEXCOORD_0 as number | undefined),
      indices:
        primitive.indices === undefined
          ? Uint32Array.from({ length: count }, (_, i) => i)
          : Uint32Array.from(readAccessor(mesh, primitive.indices as number).values),
      first: vertexCount,
    });
    vertexCount += count;
  }
});
/** Source space → the skeleton's space (set with the mesh's turn and scale below). */
let place: (v: Vector3) => Vector3 = (v) => v;
const bounds = (values: ArrayLike<number>) => {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < values.length; i++) {
    min[i % 3] = Math.min(min[i % 3], values[i]);
    max[i % 3] = Math.max(max[i % 3], values[i]);
  }
  return { min, max };
};
{
  // Facing: toes point forward, so the feet sit further forward than the shins.
  const { min, max } = bounds(all);
  const h = max[1] - min[1];
  let feet = 0;
  let feetN = 0;
  let shins = 0;
  let shinsN = 0;
  for (let i = 0; i < vertexCount; i++) {
    const y = (all[i * 3 + 1] - min[1]) / h;
    if (y < 0.04) {
      feet += all[i * 3 + 2];
      feetN++;
    } else if (y > 0.15 && y < 0.3) {
      shins += all[i * 3 + 2];
      shinsN++;
    }
  }
  const flip = feet / Math.max(1, feetN) < shins / Math.max(1, shinsN);
  const s = height / h;
  const cx = (min[0] + max[0]) / 2;
  const cz = (min[2] + max[2]) / 2;
  const hips = positionOf(joint('Hips'));
  const turn = flip ? -1 : 1;
  place = (v) =>
    v.set(
      hips.x + turn * (v.x - cx) * s,
      body.min.y + (v.y - min[1]) * s,
      hips.z + turn * (v.z - cz) * s,
    );
  const v = new Vector3();
  for (let i = 0; i < vertexCount; i++) {
    place(v.set(all[i * 3], all[i * 3 + 1], all[i * 3 + 2]));
    all[i * 3] = v.x;
    all[i * 3 + 1] = v.y;
    all[i * 3 + 2] = v.z;
  }
  for (const part of parts)
    if (flip && part.normal !== null)
      for (let i = 0; i < part.normal.length; i += 3) {
        part.normal[i] = -part.normal[i];
        part.normal[i + 2] = -part.normal[i + 2];
      }
  console.log(
    `mesh: ${vertexCount} vertices, ${flip ? 'turned to face +Z, ' : ''}scaled ×${s.toFixed(4)} to ${height.toFixed(3)} tall`,
  );
}

// --- Pose the arms like the mesh's -----------------------------------------------------------------

/** Rotates node `i` (and its subtree) about its own position so `child` points along `dir`. */
const aim = (i: number, child: number, dir: Vector3) => {
  const pivot = positionOf(i);
  const current = positionOf(child).sub(pivot).normalize();
  const turn = new Quaternion().setFromUnitVectors(current, dir.clone().normalize());
  const about = new Matrix4()
    .makeTranslation(pivot.x, pivot.y, pivot.z)
    .multiply(new Matrix4().makeRotationFromQuaternion(turn))
    .multiply(new Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
  const parent = parentOf[i] < 0 ? new Matrix4() : worldOf(parentOf[i]);
  const local = parent.invert().multiply(about).multiply(worldOf(i));
  const t = new Vector3();
  const q = new Quaternion();
  const s = new Vector3();
  local.decompose(t, q, s);
  const node = nodes[i];
  delete node.matrix;
  node.translation = t.toArray();
  node.rotation = q.toArray();
  node.scale = s.toArray();
};
// --- A rigged source: its joints by name, and the skeleton fitted to them -----------------------

const normaliseName = (name: string) => name.replace(/^.*:/, '').replace(/_\d+$/, '');
const ALIASES: Record<string, string> = {
  LeftToes: 'LeftToeBase',
  RightToes: 'RightToeBase',
  LeftArmRoll: 'LeftArm',
  RightArmRoll: 'RightArm',
  LeftForeArmRoll: 'LeftForeArm',
  RightForeArmRoll: 'RightForeArm',
};
/** The skeleton joint a source joint is (by name), or undefined. */
const directTarget = (source: number, aliases: boolean): number | undefined => {
  const name = normaliseName((mesh.json.nodes[source]?.name ?? '') as string);
  const target = byName.get(prefix + (aliases ? (ALIASES[name] ?? name) : name));
  return target !== undefined && joints.includes(target) ? target : undefined;
};
const sourceSkinNodes = [...new Set(parts.flatMap((part) => part.skin?.nodes ?? []))];
/** Skeleton joint → the source joint at the same place (exact names first, then aliases). */
const sourceFor = new Map<number, number>();
for (const aliases of [false, true])
  for (const node of sourceSkinNodes) {
    const target = directTarget(node, aliases);
    if (target !== undefined && !sourceFor.has(target)) sourceFor.set(target, node);
  }
const sourcePosition = (node: number) =>
  place(new Vector3().setFromMatrixPosition(meshWorldOf(node)));
const REQUIRED = ['Hips', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftArm', 'LeftForeArm', 'LeftHand'];
const retarget =
  sourceSkinNodes.length > 0 &&
  REQUIRED.every(
    (n) => sourceFor.has(joint(n)) && sourceFor.has(joint(n.replace('Left', 'Right'))),
  );
/** Hip height above the floor, source over skeleton (scales the clips' hip motion). */
let hipRatio = 1;
if (retarget) {
  const floor = body.min.y;
  const skeletonHips = positionOf(joint('Hips')).y - floor;
  // Bone lengths: each mapped joint's offset from its mapped parent scaled to the source's.
  const order: number[] = [];
  const visit = (n: number) => {
    order.push(n);
    for (const c of (nodes[n].children ?? []) as number[]) visit(c);
  };
  visit(joint('Hips'));
  for (const n of order) {
    const p = parentOf[n];
    const sn = sourceFor.get(n);
    const sp = p < 0 ? undefined : sourceFor.get(p);
    if (sn === undefined || sp === undefined || nodes[n].translation === undefined) continue;
    const own = positionOf(n).distanceTo(positionOf(p));
    if (own < 1e-6) continue;
    const ratio = sourcePosition(sn).distanceTo(sourcePosition(sp)) / own;
    nodes[n].translation = (nodes[n].translation as number[]).map((v) => v * ratio);
  }
  // The hips where the source's are.
  const hips = joint('Hips');
  const target = sourcePosition(sourceFor.get(hips) ?? hips);
  const local = target.applyMatrix4(
    parentOf[hips] < 0 ? new Matrix4() : worldOf(parentOf[hips]).invert(),
  );
  nodes[hips].translation = local.toArray();
  // Limbs along the source's.
  for (const side of ['Left', 'Right'])
    for (const [a, b] of [
      ['Arm', 'ForeArm'],
      ['ForeArm', 'Hand'],
      ['UpLeg', 'Leg'],
      ['Leg', 'Foot'],
    ] as const) {
      const ja = joint(`${side}${a}`);
      const jb = joint(`${side}${b}`);
      const sa = sourceFor.get(ja);
      const sb = sourceFor.get(jb);
      if (sa !== undefined && sb !== undefined)
        aim(ja, jb, sourcePosition(sb).sub(sourcePosition(sa)));
    }
  hipRatio = (positionOf(hips).y - floor) / skeletonHips;
  console.log(
    `retargeted: ${sourceFor.size} joints matched by name, bones scaled to the source, hips ×${hipRatio.toFixed(3)}`,
  );
}

if (!retarget) {
  for (const side of [1, -1] as const) {
    const name = side === 1 ? 'Left' : 'Right';
    // Left is +X for a character facing +Z. The arm: the mesh's outermost vertices on that side.
    let outer = 0;
    for (let i = 0; i < vertexCount; i++) outer = Math.max(outer, side * all[i * 3]);
    let low = new Vector3(0, Infinity, 0);
    const cluster: Vector3[] = [];
    for (let i = 0; i < vertexCount; i++)
      if (side * all[i * 3] > outer * 0.8)
        cluster.push(new Vector3(all[i * 3], all[i * 3 + 1], all[i * 3 + 2]));
    for (const p of cluster) if (p.y < low.y) low = p;
    const shoulder = positionOf(joint(`${name}Arm`));
    const hand = positionOf(joint(`${name}Hand`));
    const fingers = positionOf(joint(`${name}HandMiddle1`));
    // The wrist sits a hand's length above the lowest fingertip.
    const wrist = low.clone().add(new Vector3(0, fingers.distanceTo(hand) * 2.2, 0));
    aim(joint(`${name}Arm`), joint(`${name}Hand`), wrist.sub(shoulder));
    console.log(`${name} arm posed towards the mesh's hand at y = ${low.y.toFixed(3)}`);
  }

  // Legs: each foot joint where the mesh's foot is. The feet are the two clusters of the lowest
  // vertices (2-means in plan view), so a mid-stride scan — one foot ahead, nearly in line — works
  // as well as a standing pose; the cluster further to +X is the left foot.
  {
    const low: [number, number][] = [];
    for (let i = 0; i < vertexCount; i++)
      if (all[i * 3 + 1] < body.min.y + 0.05 * height) low.push([all[i * 3], all[i * 3 + 2]]);
    // Seeds: the two low points furthest apart.
    let a = low[0] ?? [0, 0];
    let b = a;
    for (const p of low)
      if (Math.hypot(p[0] - a[0], p[1] - a[1]) > Math.hypot(b[0] - a[0], b[1] - a[1])) b = p;
    for (const p of low)
      if (Math.hypot(p[0] - b[0], p[1] - b[1]) > Math.hypot(a[0] - b[0], a[1] - b[1])) a = p;
    const centres: [number, number][] = [[...a], [...b]];
    for (let round = 0; round < 12; round++) {
      const sum = [
        [0, 0, 0],
        [0, 0, 0],
      ];
      for (const p of low) {
        const k =
          Math.hypot(p[0] - centres[0][0], p[1] - centres[0][1]) <=
          Math.hypot(p[0] - centres[1][0], p[1] - centres[1][1])
            ? 0
            : 1;
        sum[k][0] += p[0];
        sum[k][1] += p[1];
        sum[k][2]++;
      }
      for (const k of [0, 1])
        if (sum[k][2] > 0) centres[k] = [sum[k][0] / sum[k][2], sum[k][1] / sum[k][2]];
    }
    const [leftFoot, rightFoot] =
      centres[0][0] >= centres[1][0] ? centres : [centres[1], centres[0]];
    for (const [name, centre] of [
      ['Left', leftFoot],
      ['Right', rightFoot],
    ] as const) {
      const foot = positionOf(joint(`${name}Foot`));
      const toe = positionOf(joint(`${name}ToeBase`));
      // The ankle is behind the foot's centre: back by half the heel-to-toe offset.
      const ankle = new Vector3(
        centre[0] - (toe.x - foot.x) * 0.5,
        foot.y,
        centre[1] - (toe.z - foot.z) * 0.5,
      );
      aim(
        joint(`${name}UpLeg`),
        joint(`${name}Foot`),
        ankle.sub(positionOf(joint(`${name}UpLeg`))),
      );
      console.log(
        `${name} leg posed towards the mesh's foot at (${centre[0].toFixed(3)}, ${centre[1].toFixed(3)})`,
      );
    }
  }
}

if (process.env.RIG_DEBUG) {
  for (const name of ['Hips', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'Head', 'LeftHand'])
    console.log(
      `  joint ${name}`,
      positionOf(joint(name))
        .toArray()
        .map((v) => v.toFixed(3))
        .join(','),
    );
  const { min, max } = bounds(all);
  console.log(
    '  mesh bounds',
    min.map((v) => v.toFixed(3)).join(','),
    max.map((v) => v.toFixed(3)).join(','),
  );
}
// --- Bones as capsules ---------------------------------------------------------------------------

interface Bone {
  joint: number;
  a: Vector3;
  b: Vector3;
  radius: number;
  side: number;
  /** Legs may cross the centre line (a stride); arms keep to their side. */
  leg: boolean;
}
const H = height;
const bone = (name: string, end: string, radius: number, extend = 1): Bone => {
  const a = positionOf(joint(name));
  const b = a.clone().add(positionOf(joint(end)).sub(a).multiplyScalar(extend));
  const side = name.startsWith('Left') ? 1 : name.startsWith('Right') ? -1 : 0;
  return {
    joint: joint(name),
    a,
    b,
    radius: radius * H,
    side,
    leg: /UpLeg|Leg$|Foot|Toe/.test(name),
  };
};
const bones: Bone[] = [
  bone('Hips', 'Spine', 0.09),
  bone('Spine', 'Spine1', 0.09),
  bone('Spine1', 'Spine2', 0.09),
  bone('Spine2', 'Neck', 0.09),
  bone('Neck', 'Head', 0.035),
  bone('Head', 'HeadTop_End', 0.06),
];
for (const side of ['Left', 'Right']) {
  bones.push(
    bone(`${side}Shoulder`, `${side}Arm`, 0.035),
    bone(`${side}Arm`, `${side}ForeArm`, 0.03),
    bone(`${side}ForeArm`, `${side}Hand`, 0.028),
    bone(`${side}Hand`, `${side}HandMiddle1`, 0.025, 2.2),
    bone(`${side}UpLeg`, `${side}Leg`, 0.045),
    bone(`${side}Leg`, `${side}Foot`, 0.035),
    bone(`${side}Foot`, `${side}ToeBase`, 0.03),
    bone(`${side}ToeBase`, `${side}Toe_End`, 0.025),
  );
}
const adjacent = (p: Bone, q: Bone) =>
  parentOf[p.joint] === q.joint || parentOf[q.joint] === p.joint;
const score = (bi: Bone, x: number, y: number, z: number): number => {
  const abx = bi.b.x - bi.a.x;
  const aby = bi.b.y - bi.a.y;
  const abz = bi.b.z - bi.a.z;
  const t = Math.max(
    0,
    Math.min(
      1,
      ((x - bi.a.x) * abx + (y - bi.a.y) * aby + (z - bi.a.z) * abz) /
        (abx * abx + aby * aby + abz * abz || 1),
    ),
  );
  return Math.hypot(x - bi.a.x - abx * t, y - bi.a.y - aby * t, z - bi.a.z - abz * t) - bi.radius;
};
/** Near the centre line either side may take a vertex; elsewhere an arm bone only its own side. */
/** Below the hip joints the body is legs (and hanging hands): no torso bone there. */
const hipLine =
  (positionOf(joint('LeftUpLeg')).y + positionOf(joint('RightUpLeg')).y) / 2 - 0.02 * height;
const allowed = (bi: Bone, x: number, centreX: number, y: number) =>
  (bi.side === 0 && y >= hipLine) ||
  bi.leg ||
  Math.abs(x - centreX) < 0.02 * H ||
  Math.sign(x - centreX) === bi.side;

// --- Connected parts ---------------------------------------------------------------------------

const parent = Int32Array.from({ length: vertexCount }, (_, i) => i);
const find = (i: number): number => {
  while (parent[i] !== i) {
    parent[i] = parent[parent[i]];
    i = parent[i];
  }
  return i;
};
{
  const byPosition = new Map<string, number>();
  for (let i = 0; i < vertexCount; i++) {
    const key = `${all[i * 3].toFixed(5)},${all[i * 3 + 1].toFixed(5)},${all[i * 3 + 2].toFixed(5)}`;
    const other = byPosition.get(key);
    if (other === undefined) byPosition.set(key, i);
    else parent[find(i)] = find(other);
  }
  for (const part of parts)
    for (let t = 0; t < part.indices.length; t += 3) {
      const a = find(part.first + part.indices[t]);
      parent[find(part.first + part.indices[t + 1])] = a;
      parent[find(part.first + part.indices[t + 2])] = a;
    }
}
const centreX = positionOf(joint('Hips')).x;
const nearest = new Int32Array(vertexCount);
const components = new Map<number, number[]>();
for (let i = 0; i < vertexCount; i++) {
  const [x, y, z] = [all[i * 3], all[i * 3 + 1], all[i * 3 + 2]];
  let best = 0;
  let bestScore = Infinity;
  bones.forEach((bi, k) => {
    if (!allowed(bi, x, centreX, y)) return;
    const s = score(bi, x, y, z);
    if (s < bestScore) {
      bestScore = s;
      best = k;
    }
  });
  nearest[i] = best;
  const root = find(i);
  const list = components.get(root);
  if (list === undefined) components.set(root, [i]);
  else list.push(i);
}

const jointsOut = new Uint8Array(vertexCount * 4);
const weightsOut = new Float32Array(vertexCount * 4);
const jointIndex = new Map(joints.map((node, i) => [node, i]));
const put = (i: number, a: Bone, b: Bone | null, wb: number) => {
  jointsOut[i * 4] = jointIndex.get(a.joint) ?? 0;
  weightsOut[i * 4] = 1 - wb;
  if (b !== null && wb > 0) {
    jointsOut[i * 4 + 1] = jointIndex.get(b.joint) ?? 0;
    weightsOut[i * 4 + 1] = wb;
  }
};
let rigidParts = 0;
let blendedParts = 0;
for (const list of components.values()) {
  const votes = new Map<number, number>();
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const i of list) {
    votes.set(nearest[i], (votes.get(nearest[i]) ?? 0) + 1);
    for (let c = 0; c < 3; c++) {
      lo[c] = Math.min(lo[c], all[i * 3 + c]);
      hi[c] = Math.max(hi[c], all[i * 3 + c]);
    }
  }
  const span = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const ranked = [...votes.entries()].sort((p, q) => q[1] - p[1]);
  const top = bones[ranked[0]?.[0] ?? 0];
  if (span < 0.1 * H || (ranked[0]?.[1] ?? 0) > list.length * 0.9) {
    rigidParts++;
    if (process.env.RIG_DEBUG)
      console.log(`  rigid ${list.length} v, span ${span.toFixed(2)} → ${nodes[top.joint].name}`);
    for (const i of list) put(i, top, null, 0);
    continue;
  }
  blendedParts++;
  if (process.env.RIG_DEBUG)
    console.log(
      `  blended ${list.length} v, span ${span.toFixed(2)}: ${ranked
        .slice(0, 40)
        .map(([k, n]) => `${nodes[bones[k].joint].name}:${n}`)
        .join(' ')}`,
    );
  const candidates = ranked.filter(([, n]) => n >= list.length * 0.05).map(([k]) => bones[k]);
  const sigma = 0.012 * H;
  for (const i of list) {
    const [x, y, z] = [all[i * 3], all[i * 3 + 1], all[i * 3 + 2]];
    const scored = candidates
      .filter((bi) => allowed(bi, x, centreX, y))
      .map((bi) => ({ bi, s: score(bi, x, y, z) }))
      .sort((p, q) => p.s - q.s);
    const first = scored[0] ?? { bi: top, s: 0 };
    const second = scored.find((c) => c !== first && adjacent(c.bi, first.bi));
    const wb = second === undefined ? 0 : 0.5 * Math.exp(-(second.s - first.s) / sigma);
    put(i, first.bi, second?.bi ?? null, wb);
  }
}
console.log(
  `skinning: ${components.size} parts, ${rigidParts} rigid, ${blendedParts} blended over joints`,
);

// A rigged source keeps its own weights, moved onto the skeleton's joints by name (unmatched
// joints — face, props, roll bones — hand theirs to the nearest matched ancestor).
if (retarget) {
  const targetOf = new Map<number, number>();
  for (const node of sourceSkinNodes) {
    let target: number | undefined;
    for (let n = node; n >= 0 && target === undefined; n = meshParent[n])
      target = directTarget(n, true);
    targetOf.set(node, jointIndex.get(target ?? joint('Hips')) ?? 0);
  }
  for (const part of parts) {
    if (part.skin === null) continue;
    const count = part.position.length / 3;
    for (let i = 0; i < count; i++) {
      const sums = new Map<number, number>();
      for (let k = 0; k < 4; k++) {
        const w = part.skin.weights[i * 4 + k];
        if (w <= 0) continue;
        const target = targetOf.get(part.skin.nodes[part.skin.joints[i * 4 + k]]) ?? 0;
        sums.set(target, (sums.get(target) ?? 0) + w);
      }
      const top = [...sums.entries()].sort((p, q) => q[1] - p[1]).slice(0, 4);
      const total = top.reduce((t, [, w]) => t + w, 0) || 1;
      const v = part.first + i;
      for (let k = 0; k < 4; k++) {
        jointsOut[v * 4 + k] = top[k]?.[0] ?? 0;
        weightsOut[v * 4 + k] = (top[k]?.[1] ?? 0) / total;
      }
    }
  }
  console.log('skinning: the source model\u2019s own weights, moved onto the skeleton');
}

// --- Write: skeleton nodes, the skinned mesh, inverse binds, clips --------------------------------

const writer = new GlbWriter();
const json = writer.json;
// The skeleton model's own meshes are dropped; its nodes stay (clips address them by index).
json.nodes = nodes.map((node) => {
  const copy = { ...node };
  delete copy.mesh;
  delete copy.skin;
  return copy;
});
json.materials = structuredClone(mesh.json.materials ?? []);
// Textures travel with the materials: embedded images are copied into the new binary chunk.
if (mesh.json.images !== undefined) {
  json.images = (mesh.json.images as GltfJson[]).map((image) => {
    if (image.bufferView === undefined) return image;
    const view = mesh.json.bufferViews[image.bufferView];
    const start = (view.byteOffset ?? 0) as number;
    return {
      mimeType: image.mimeType,
      bufferView: writer.view(mesh.bin.subarray(start, start + (view.byteLength as number))),
    };
  });
  json.textures = structuredClone(mesh.json.textures ?? []);
  json.samplers = structuredClone(mesh.json.samplers ?? []);
}
if (mesh.json.extensionsUsed !== undefined) json.extensionsUsed = mesh.json.extensionsUsed;

const primitives = parts.map((part) => {
  const count = part.position.length / 3;
  const position = Float32Array.from(all.slice(part.first * 3, (part.first + count) * 3));
  const attributes: Record<string, number> = {
    POSITION: writer.accessor(position, 'VEC3', { target: 34962, minMax: true }),
    JOINTS_0: writer.accessor(jointsOut.slice(part.first * 4, (part.first + count) * 4), 'VEC4', {
      target: 34962,
    }),
    WEIGHTS_0: writer.accessor(weightsOut.slice(part.first * 4, (part.first + count) * 4), 'VEC4', {
      target: 34962,
    }),
  };
  if (part.normal !== null)
    attributes.NORMAL = writer.accessor(part.normal, 'VEC3', { target: 34962 });
  if (part.uv !== null) attributes.TEXCOORD_0 = writer.accessor(part.uv, 'VEC2', { target: 34962 });
  return {
    attributes,
    indices: writer.accessor(part.indices, 'SCALAR', { target: 34963 }),
    ...(part.material === undefined ? {} : { material: part.material }),
  };
});
json.meshes = [{ name: 'robot', primitives }];

const inverseBinds = new Float32Array(joints.length * 16);
joints.forEach((node, i) => {
  inverseBinds.set(worldOf(node).invert().elements, i * 16);
});
json.skins = [
  {
    joints,
    inverseBindMatrices: writer.accessor(inverseBinds, 'MAT4'),
    ...(skin.skeleton === undefined ? {} : { skeleton: skin.skeleton }),
  },
];
json.nodes.push({ name: 'robot', mesh: 0, skin: 0 });
const meshNodeIndex = json.nodes.length - 1;
const rootNodes = (rig.json.scenes[rig.json.scene ?? 0].nodes as number[]).filter(
  (n) => rig.json.nodes[n].mesh === undefined || rig.json.nodes[n].skin === undefined,
);
json.scenes = [{ name: 'Scene', nodes: [...rootNodes, meshNodeIndex] }];
json.scene = 0;

const copyAccessor = (source: Glb, index: number, minMax: boolean): number => {
  const accessor = source.json.accessors[index];
  const { values } = readAccessor(source, index);
  return writer.accessor(Float32Array.from(values), accessor.type, { minMax });
};
json.animations = [];
for (const name of clips) {
  const clip = (rig.json.animations as GltfJson[]).find((a) => a.name === name);
  if (clip === undefined) {
    console.warn(`skeleton model has no clip "${name}"`);
    continue;
  }
  // Retargeted: rotations only, plus the hips' motion scaled to the new hip height; the other
  // joints keep the source's bone lengths. Finger rotations are left out (unless --finger-clips):
  // a source whose finger joints are named like Mixamo's but rest in other orientations (Ready
  // Player Me avatars, for one) gets twisted fingers from X Bot's; without them the fingers keep
  // the pose the model was made in, and walk, idle and run barely move fingers anyway.
  const hips = joint('Hips');
  const fingerJoint = (node: number) =>
    /Hand(Thumb|Index|Middle|Ring|Pinky)\d/.test((rig.json.nodes[node]?.name ?? '') as string);
  const keepFingers = process.argv.includes('--finger-clips');
  const channels = (clip.channels as GltfJson[]).filter(
    (c) =>
      !retarget ||
      (c.target.path === 'rotation' && (keepFingers || !fingerJoint(c.target.node as number))) ||
      (c.target.path === 'translation' && c.target.node === hips),
  );
  const samplers = channels.map((channel) => {
    const sampler = clip.samplers[channel.sampler];
    const scaleBy = retarget && channel.target.path === 'translation' ? hipRatio : 1;
    const { values } = readAccessor(rig, sampler.output as number);
    return {
      input: copyAccessor(rig, sampler.input as number, true),
      output: writer.accessor(
        Float32Array.from(values, (v) => v * scaleBy),
        rig.json.accessors[sampler.output].type,
      ),
      interpolation: sampler.interpolation ?? 'LINEAR',
    };
  });
  json.animations.push({
    name,
    samplers,
    channels: channels.map((c, i) => ({ sampler: i, target: structuredClone(c.target) })),
  });
}

const glb = writer.toGlb();
writeFileSync(out, glb);
console.log(
  `wrote ${out}: ${(glb.byteLength / 1024 / 1024).toFixed(2)} MB, ${joints.length} joints, clips ${json.animations.map((a: GltfJson) => a.name).join(', ')}`,
);
