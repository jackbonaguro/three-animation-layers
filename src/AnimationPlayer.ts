import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader';
import { LayeredMixer, AnimationLayerMask, AnimationLayer, LayerAction } from './animation';

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
  /** Duration (seconds) for layer fade-in / fade-out transitions. */
  static readonly FADE_SECONDS = 0.35;

  readonly rig: THREE.Object3D;
  readonly mixer: LayeredMixer;

  private overlayLayer: AnimationLayer | null = null;
  private punchAction: LayerAction | null = null;
  private runningAction: LayerAction | null = null;
  private _punchVisible = false;
  private _runningActive = true;

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
    if (!this.punchAction) return;
    this._punchVisible = !this._punchVisible;
    if (this._punchVisible) {
      this.punchAction.play();
      this.punchAction.fadeIn(AnimationPlayer.FADE_SECONDS);
    } else {
      this.punchAction.fadeOut(AnimationPlayer.FADE_SECONDS);
    }
  }

  toggleRunningLayer(): void {
    if (!this.runningAction) return;
    this._runningActive = !this._runningActive;
    if (this._runningActive) {
      this.runningAction.reset();
      this.runningAction.fadeIn(AnimationPlayer.FADE_SECONDS);
    } else {
      this.runningAction.fadeOut(AnimationPlayer.FADE_SECONDS);
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
    const baseLayer = this.mixer.addLayer('base');
    if (clips.runningClip) {
      this.runningAction = baseLayer.play(clips.runningClip);
    }

    if (clips.punchClip) {
      const upperBodyMask = new AnimationLayerMask({
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
      this.punchAction = this.overlayLayer.play(clips.punchClip);
      // Start disabled; caller uses togglePunchLayer() to fade it in.
      this.punchAction.enabled = false;
      this.punchAction.syncEffectiveWeight(this.mixer.time);
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
