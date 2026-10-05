import { Vector3, Vector4 } from 'three';
import type { CityView } from './city-view.ts';

/** A named building (labels.json, from tools/osm-pipeline labels): region frame, roof height. */
export interface BuildingLabel {
  name: string;
  x: number;
  y: number;
  top: number;
}

export interface BuildingLabels {
  setVisible(visible: boolean): void;
  dispose(): void;
}

/** Labels on screen at once, and how far away a building can be labelled. */
const MAX_LABELS = 40;
const MAX_DISTANCE_M = 3000;
/** How often the set of labels is chosen again; positions follow every frame. */
const SELECT_MS = 150;
/** Height of a label's tip above the roof. */
const LIFT_M = 6;
/** Labels of towers taller than the view are pinned this far below its top edge. */
const TOP_MARGIN_PX = 26;

/**
 * Names over the city's buildings, as HTML labels in `layer` (above the canvas, below the
 * panel). Several times a second it picks up to 40 named buildings in view within 3 km, tallest
 * and nearest first, skipping any whose label would overlap one already placed; every frame it
 * moves the chosen labels with the camera.
 */
export function startBuildingLabels(
  layer: HTMLElement,
  labels: readonly BuildingLabel[],
  view: CityView,
  /** Screen areas to keep clear (the panel), read when the labels are chosen. */
  covered: () => DOMRect[] = () => [],
): BuildingLabels {
  const pool = Array.from({ length: MAX_LABELS }, () => {
    const element = document.createElement('div');
    element.className = 'building-label';
    element.hidden = true;
    layer.append(element);
    return element;
  });
  const world = labels.map((l) => new Vector3(l.x, l.top + LIFT_M, -l.y));
  /** A point low on each building (up to 30 m), for towers whose roof is above the screen. */
  const low = labels.map((l) => new Vector3(l.x, Math.min(l.top, 30), -l.y));
  /** Label index shown by each pool element (−1: unused). */
  let shown: number[] = [];
  let visible = true;
  let lastSelect = -Infinity;
  const eye = new Vector3();
  const clip = new Vector4();

  /** Screen position (CSS px) of label i, or null if behind the camera or off screen. */
  type Camera = Parameters<Parameters<CityView['addFrameHook']>[0]>[0];
  const project = (p: Vector3, camera: Camera, width: number, height: number) => {
    clip.set(p.x, p.y, p.z, 1).applyMatrix4(camera.matrixWorldInverse);
    clip.applyMatrix4(camera.projectionMatrix);
    if (clip.w <= 0) return null;
    return {
      x: ((clip.x / clip.w + 1) / 2) * width,
      y: ((1 - clip.y / clip.w) / 2) * height,
    };
  };
  /**
   * Where label i goes (CSS px): over its roof, or, for a tower whose roof is above the screen
   * while its lower floors are on it, pinned to the top edge above the tower. Null if not in view.
   */
  const toScreen = (
    i: number,
    camera: Camera,
    width: number,
    height: number,
  ): { x: number; y: number } | null => {
    const roof = project(world[i], camera, width, height);
    if (roof !== null && roof.y >= TOP_MARGIN_PX) {
      if (roof.x < -50 || roof.x > width + 50 || roof.y > height + 40) return null;
      return roof;
    }
    const base = project(low[i], camera, width, height);
    if (base === null || base.y < TOP_MARGIN_PX || base.y > height || base.x < 0 || base.x > width)
      return null;
    return { x: base.x, y: TOP_MARGIN_PX };
  };

  const remove = view.addFrameHook((camera) => {
    if (!visible) return;
    const width = layer.clientWidth;
    const height = layer.clientHeight;
    const now = performance.now();
    eye.setFromMatrixPosition(camera.matrixWorld);
    if (now - lastSelect >= SELECT_MS) {
      lastSelect = now;
      const candidates: { i: number; score: number; x: number; y: number; d: number }[] = [];
      for (let i = 0; i < world.length; i++) {
        const d = eye.distanceTo(world[i]);
        if (d > MAX_DISTANCE_M) continue;
        const s = toScreen(i, camera, width, height);
        if (s === null) continue;
        candidates.push({ i, score: (labels[i].top + 10) / Math.max(d, 20), x: s.x, y: s.y, d });
      }
      candidates.sort((a, b) => b.score - a.score);
      const origin = layer.getBoundingClientRect();
      const placed: { left: number; right: number; top: number; bottom: number }[] = covered().map(
        (r) => ({
          left: r.left - origin.left,
          right: r.right - origin.left,
          top: r.top - origin.top,
          bottom: r.bottom - origin.top,
        }),
      );
      shown = [];
      for (const c of candidates) {
        if (shown.length === MAX_LABELS) break;
        const w = labels[c.i].name.length * 6.6 + 14;
        const box = { left: c.x - w / 2, right: c.x + w / 2, top: c.y - 22, bottom: c.y };
        if (
          placed.some(
            (o) =>
              box.left < o.right && box.right > o.left && box.top < o.bottom && box.bottom > o.top,
          )
        )
          continue;
        placed.push(box);
        shown.push(c.i);
      }
      pool.forEach((element, k) => {
        if (k >= shown.length) {
          element.hidden = true;
          return;
        }
        const i = shown[k];
        if (element.textContent !== labels[i].name) element.textContent = labels[i].name;
        element.hidden = false;
      });
    }
    for (let k = 0; k < shown.length; k++) {
      const element = pool[k];
      const s = toScreen(shown[k], camera, width, height);
      if (s === null) {
        element.style.opacity = '0';
        continue;
      }
      const d = eye.distanceTo(world[shown[k]]);
      element.style.opacity = String(Math.max(0.45, Math.min(1, 1.25 - d / MAX_DISTANCE_M)));
      element.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px) translate(-50%, -100%)`;
    }
  });

  return {
    setVisible(next) {
      visible = next;
      layer.hidden = !next;
    },
    dispose() {
      remove();
      for (const element of pool) element.remove();
    },
  };
}
