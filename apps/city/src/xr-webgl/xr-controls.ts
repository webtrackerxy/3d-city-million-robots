import { type Group, type PerspectiveCamera, Vector3, type WebGLRenderer } from 'three';

/**
 * Map XR controls (Meta Quest Touch, the WebXR xr-standard gamepad layout):
 *
 * - left thumbstick: walk the way you look (1.6 m/s); grip or trigger held: 6 m/s
 * - right thumbstick left/right: turn 30° (snap, for comfort)
 * - B (right controller): leave VR
 *
 * The desktop preview takes WASD to walk, Q/E to turn and Shift to go faster. The viewer stays
 * on the ground (`groundAt`) as it rises and falls.
 */
export interface XrControls {
  update(dtMs: number): void;
  dispose(): void;
}

const WALK_MPS = 1.6;
const RUN_MPS = 6;
const TURN_RAD = Math.PI / 6;
const DEADZONE = 0.15;
/** xr-standard gamepad indices. */
const BUTTON = { trigger: 0, squeeze: 1, b: 5 } as const;
const AXIS = { x: 2, y: 3 } as const;

export function createXrControls(options: {
  renderer: WebGLRenderer;
  rig: Group;
  camera: PerspectiveCamera;
  /** Ground height (Three y) at (x, z). */
  groundAt: (x: number, z: number) => number;
  onExit: () => void;
  preview: boolean;
}): XrControls {
  const { renderer, rig, camera } = options;
  const up = new Vector3(0, 1, 0);
  const forward = new Vector3();
  const right = new Vector3();
  const head = new Vector3();
  let bWasDown = false;
  let turnReady = true;
  const keys = new Set<string>();
  const onKeyDown = (e: KeyboardEvent) => {
    keys.add(e.key.toLowerCase());
  };
  const onKeyUp = (e: KeyboardEvent) => {
    keys.delete(e.key.toLowerCase());
    if (e.key.toLowerCase() === 'q' || e.key.toLowerCase() === 'e') turnReady = true;
  };
  if (options.preview) {
    addEventListener('keydown', onKeyDown);
    addEventListener('keyup', onKeyUp);
  }

  /** Turns the rig by `angle` about the viewer's head, so the view does not swing round. */
  const turn = (angle: number) => {
    camera.getWorldPosition(head);
    rig.position.sub(head).applyAxisAngle(up, angle).add(head);
    rig.rotation.y += angle;
  };

  return {
    update(dtMs) {
      const dt = Math.min(dtMs, 100) / 1000;
      // Stick input: x right, y forward (gamepads give up as −1).
      let moveX = 0;
      let moveY = 0;
      let fast = false;
      let turnX = 0;
      const session = renderer.xr.getSession();
      if (session !== null) {
        for (const source of session.inputSources) {
          const pad = source.gamepad;
          if (pad === undefined) continue;
          const x = pad.axes[AXIS.x] ?? 0;
          const y = pad.axes[AXIS.y] ?? 0;
          if (source.handedness === 'left') {
            moveX = x;
            moveY = -y;
            fast ||=
              (pad.buttons[BUTTON.squeeze]?.pressed ?? false) ||
              (pad.buttons[BUTTON.trigger]?.pressed ?? false);
          } else if (source.handedness === 'right') {
            turnX = x;
            const b = pad.buttons[BUTTON.b]?.pressed ?? false;
            if (b && !bWasDown) options.onExit();
            bWasDown = b;
          }
        }
      } else if (options.preview) {
        moveY = (keys.has('w') ? 1 : 0) - (keys.has('s') ? 1 : 0);
        moveX = (keys.has('d') ? 1 : 0) - (keys.has('a') ? 1 : 0);
        fast = keys.has('shift');
        if (turnReady && (keys.has('q') || keys.has('e'))) {
          turn(keys.has('q') ? TURN_RAD : -TURN_RAD);
          turnReady = false;
        }
      }

      // Snap turn once per push of the stick.
      if (Math.abs(turnX) > 0.7 && turnReady) {
        turn(turnX > 0 ? -TURN_RAD : TURN_RAD);
        turnReady = false;
      } else if (Math.abs(turnX) < 0.3 && session !== null) turnReady = true;

      if (Math.hypot(moveX, moveY) > DEADZONE) {
        // The way the head looks, flattened onto the ground.
        camera.getWorldDirection(forward);
        forward.y = 0;
        if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
        forward.normalize();
        right.crossVectors(forward, up);
        const speed = (fast ? RUN_MPS : WALK_MPS) * dt;
        rig.position.addScaledVector(forward, moveY * speed).addScaledVector(right, moveX * speed);
      }
      // Feet on the ground, easing over steps in the terrain grid.
      const ground = options.groundAt(rig.position.x, rig.position.z);
      rig.position.y += (ground - rig.position.y) * Math.min(1, dt * 8);
    },
    dispose() {
      removeEventListener('keydown', onKeyDown);
      removeEventListener('keyup', onKeyUp);
    },
  };
}
