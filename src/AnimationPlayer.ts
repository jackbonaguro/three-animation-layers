import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader';
import { LayeredMixer, AnimationLayerMask, AnimationLayer } from './animation';

export type PlayerClips = {
  tposeClip?: THREE.AnimationClip;
  idleClip?: THREE.AnimationClip;
  runningClip?: THREE.AnimationClip;
  punchClip?: THREE.AnimationClip;
};

/**
 * Animated character: rig root, {@link LayeredMixer}, and layered clip setup.
 */
export default class AnimationPlayer {
  readonly rig: THREE.Object3D;
  readonly mixer: LayeredMixer;

  private overlayLayer: AnimationLayer | null = null;

  constructor(rig: THREE.Object3D, clips: PlayerClips) {
    this.rig = rig;
    this.mixer = new LayeredMixer(rig);
    this.setupAnimationLayers(clips);
  }

  addToScene(scene: THREE.Scene): void {
    scene.add(this.rig);
  }

  update(deltaSeconds: number): void {
    this.mixer.update(deltaSeconds);
  }

  togglePunchLayer(): void {
    if (this.overlayLayer) {
      this.overlayLayer.weight = this.overlayLayer.weight > 0 ? 0 : 1;
    }
  }

  toggleRunningLayer(): void {
    const baseLayer = this.mixer.layers[0];
    if (baseLayer && baseLayer.actions.length > 0) {
      const action = baseLayer.actions[0];
      if (action.enabled) {
        action.enabled = false;
      } else {
        action.reset();
      }
    }
  }

  /** Load an FBX rig (scale, shadows), extract clips, and construct the player. */
  static async loadFromFbx(
    url = './testChar.backup.fbx',
    scale = 0.05,
  ): Promise<AnimationPlayer> {
    const rig = await AnimationPlayer.loadFbxRig(url, scale);
    const clips = AnimationPlayer.extractClipsFromRig(rig);
    return new AnimationPlayer(rig, clips);
  }

  private static async loadFbxRig(url: string, scale: number): Promise<THREE.Group> {
    const loader = new FBXLoader();
    const rig = await new Promise<THREE.Group>((res, rej) => {
      loader.load(url, res, undefined, rej);
    });
    rig.traverse(function (node) {
      if (node instanceof THREE.Mesh) {
        node.castShadow = true;
      }
    });
    rig.scale.multiplyScalar(scale);
    return rig;
  }

  /** Build normalized clips from animations embedded on a loaded rig (e.g. FBX). */
  static extractClipsFromRig(rig: THREE.Object3D): PlayerClips {
    return {
      tposeClip: AnimationPlayer.nameToClip(rig, 'TPose'),
      idleClip: AnimationPlayer.nameToClip(rig, 'Idle'),
      runningClip: AnimationPlayer.nameToClip(rig, 'Running'),
      punchClip: AnimationPlayer.nameToClip(rig, 'Punch_1'),
    };
  }

  private setupAnimationLayers(clips: PlayerClips): void {
    // Layer 0 — full-body base.
    const baseLayer = this.mixer.addLayer('base');
    if (clips.runningClip) {
      baseLayer.play(clips.runningClip);
    }

    // Layer 1 — upper-body override (higher priority than base).
    if (clips.punchClip) {
      const upperBodyMask = new AnimationLayerMask({
        // 'mixamorigHips.quaternion': 0.5,
        'mixamorigSpine.quaternion': 1,
        'mixamorigSpine1.quaternion': 1,
        'mixamorigSpine2.quaternion': 1,
        'mixamorigNeck.quaternion': 1,
        'mixamorigHead.quaternion': 1,
        'mixamorigLeftShoulder.quaternion': 1,
        'mixamorigLeftArm.quaternion': 1,
        'mixamorigLeftForeArm.quaternion': 1,
        'mixamorigLeftHand.quaternion': 1,
        'mixamorigRightShoulder.quaternion': 1,
        'mixamorigRightArm.quaternion': 1,
        'mixamorigRightForeArm.quaternion': 1,
        'mixamorigRightHand.quaternion': 1,
      });

      this.overlayLayer = this.mixer.addLayer('overlay', { mask: upperBodyMask });
      this.overlayLayer.play(clips.punchClip);
    }
  }

  private static nameToClip(
    fbx: THREE.Object3D,
    name: string,
  ): THREE.AnimationClip | undefined {
    let clip = fbx.animations.find((a) => a.name.includes(name))?.clone();
    if (!clip) return;
    clip = AnimationPlayer.normalizeClip(clip);
    return clip;
  }

  private static normalizeClip(clip: THREE.AnimationClip): THREE.AnimationClip {
    const filterWords = ['position', 'scale'];
    const filteredTracks = clip.tracks.filter((track) => {
      return !filterWords.some((fw) => track.name.toLowerCase().includes(fw));
    });
    const hipsPositionTrack = clip.tracks.find((track) => {
      return track.name.toLowerCase().includes('hips') && track.name.toLowerCase().includes('position');
    });
    if (hipsPositionTrack) {
      for (let i = 0; i < hipsPositionTrack.values.length; i++) {
        if (i % 3 !== 1) {
          hipsPositionTrack.values[i] = 0;
        }
      }
      filteredTracks.push(hipsPositionTrack);
    }
    clip.tracks = filteredTracks;
    return clip;
  }
}
