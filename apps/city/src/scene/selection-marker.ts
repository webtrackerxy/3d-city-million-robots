import {
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
  type Scene,
  type Vector3,
} from 'three';

/**
 * Highlights the selected person, robot or car: a glowing ring at its feet and an arrow above it,
 * drawn over everything so it shows behind a building too.
 */
export interface SelectionMarker {
  /**
   * Puts the marker at `position` (Three coordinates), sized for a body `radius` metres wide and
   * `height` tall, and never smaller on screen than a few pixels from `distance` metres away.
   */
  show(position: Vector3, radius: number, height: number, distance: number): void;
  hide(): void;
  dispose(): void;
}

const ACCENT = 0x4dd9e6;

export function createSelectionMarker(scene: Scene): SelectionMarker {
  const material = new MeshBasicMaterial({
    color: ACCENT,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
    depthWrite: false,
  });
  // A dark rim under the ring so it reads on the pale street map as well as on photos.
  const rimMaterial = new MeshBasicMaterial({
    color: 0x0b1016,
    transparent: true,
    opacity: 0.6,
    depthTest: false,
    depthWrite: false,
  });
  const group = new Group();
  group.renderOrder = 10;
  const ring = new Mesh(new RingGeometry(0.8, 1, 48), material);
  ring.rotation.x = -Math.PI / 2;
  const rim = new Mesh(new RingGeometry(0.72, 1.08, 48), rimMaterial);
  rim.rotation.x = -Math.PI / 2;
  const arrow = new Mesh(new ConeGeometry(0.25, 0.5, 16), material);
  arrow.rotation.x = Math.PI;
  const stem = new Mesh(new CylinderGeometry(0.05, 0.05, 0.6, 8), material);
  rim.renderOrder = 9;
  rim.frustumCulled = false;
  group.add(rim);
  for (const mesh of [ring, arrow, stem]) {
    mesh.renderOrder = 10;
    mesh.frustumCulled = false;
    group.add(mesh);
  }
  group.visible = false;
  scene.add(group);
  let started = performance.now();
  return {
    show(position, radius, height, distance) {
      if (!group.visible) started = performance.now();
      group.visible = true;
      group.position.copy(position);
      // At least ~1.5% of the view distance across, so it shows when zoomed out too.
      const size = Math.max(radius, distance * 0.015);
      const arrowScale = Math.max(1, distance / 50);
      // The ring breathes a little so the eye finds it.
      const t = performance.now() - started;
      const pulse = 1 + 0.12 * Math.sin(t / 180);
      ring.scale.setScalar(size * pulse);
      rim.scale.setScalar(size * pulse);
      ring.position.y = 0.05;
      rim.position.y = 0.04;
      const bob = 0.15 * arrowScale * Math.sin(t / 260);
      arrow.scale.setScalar(arrowScale);
      stem.scale.setScalar(arrowScale);
      arrow.position.y = height + 0.6 * arrowScale + bob;
      stem.position.y = height + 1.15 * arrowScale + bob;
    },
    hide() {
      group.visible = false;
    },
    dispose() {
      scene.remove(group);
      for (const mesh of [ring, rim, arrow, stem]) mesh.geometry.dispose();
      material.dispose();
      rimMaterial.dispose();
    },
  };
}
