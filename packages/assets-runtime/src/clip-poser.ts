import {
  type AnimationClip,
  AnimationMixer,
  LoopOnce,
  LoopRepeat,
  type Object3D,
  type Quaternion,
  type Vector3,
} from 'three';

interface LocalTransform {
  node: Object3D;
  position: Vector3;
  quaternion: Quaternion;
  scale: Vector3;
}

/**
 * Poses a character at an exact clip time using a single AnimationMixer. This is a baking and
 * verification tool only: it must never be instantiated per rendered character.
 *
 * `dispose` restores every node's local transform as it was at construction. Skeleton.pose() is
 * not used for this: it treats the root bone's world matrix as its local one, which is wrong
 * whenever the skinned mesh is not at the origin.
 */
export class ClipPoser {
  private readonly root: Object3D;
  private readonly mixer: AnimationMixer;
  private readonly saved: LocalTransform[] = [];

  constructor(root: Object3D) {
    this.root = root;
    this.mixer = new AnimationMixer(root);
    root.traverse((node) => {
      this.saved.push({
        node,
        position: node.position.clone(),
        quaternion: node.quaternion.clone(),
        scale: node.scale.clone(),
      });
    });
  }

  pose(clip: AnimationClip, time: number, loop: boolean): void {
    this.mixer.stopAllAction();
    const action = this.mixer.clipAction(clip);
    action.setLoop(loop ? LoopRepeat : LoopOnce, Infinity);
    action.clampWhenFinished = !loop;
    action.play();
    this.mixer.setTime(time);
    this.root.updateMatrixWorld(true);
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
    for (const { node, position, quaternion, scale } of this.saved) {
      node.position.copy(position);
      node.quaternion.copy(quaternion);
      node.scale.copy(scale);
    }
    this.root.updateMatrixWorld(true);
  }
}
