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
  private _runningHeld = false;
  /** Punch outro: avoid scheduling fadeOut(remaining) more than once per swing. */
  private _punchEndFadeScheduled = false;

  constructor(rig: THREE.Object3D, clips: PlayerClips) {
    this.rig = rig;
    this.mixer = new LayeredMixer(rig);
    this.setupAnimationLayers(clips);
  }

  addToScene(scene: THREE.Scene): void {
    scene.add(this.rig);
  }

  update(deltaSeconds: number): void {
    // Three.js pattern: fade-out duration = remaining local clip time so the clip
    // end lines up with weight reaching 0. Sync before and after the mixer step so
    // a large delta does not skip the fade window entirely.
    this.syncPunchOutroFade();
    this.mixer.update(deltaSeconds);
    this.syncPunchOutroFade();
  }

  /**
   * When local time is within {@link FADE_SECONDS} of the clip end, call
   * `fadeOut(remaining)` so the fade finishes as the clip finishes. If we are
   * already parked on the last frame (`remaining === 0`), fade over
   * {@link FADE_SECONDS} on the held pose (large-dt fallback).
   */
  private syncPunchOutroFade(): void {
    const a = this.punchAction;
    if (!a || !a.enabled || this._punchEndFadeScheduled) return;
    const dur = a.clip.duration;
    if (dur <= 0) return;
    const fade = AnimationPlayer.FADE_SECONDS;
    const remaining = Math.max(0, dur - a.time);
    if (remaining > fade + 1e-6) return;
    const outDuration = remaining > 1e-6 ? remaining : fade;
    a.fadeOut(outDuration);
    this._punchEndFadeScheduled = true;
  }

  /** Fire a single punch cycle (non-looping clip). Each press restarts from the beginning. */
  triggerPunch(): void {
    if (!this.punchAction) return;
    this._punchEndFadeScheduled = false;
    this.punchAction.reset();
    this.punchAction.fadeIn(AnimationPlayer.FADE_SECONDS);
  }

  /** Call while W is held to run; release to stop (with fade in/out). */
  setRunningHeld(held: boolean): void {
    if (!this.runningAction) return;
    if (held === this._runningHeld) return;
    this._runningHeld = held;
    if (held) {
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
      this.runningAction.enabled = false;
      this.runningAction.syncEffectiveWeight(this.mixer.time);
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
      this.punchAction.loop = THREE.LoopOnce;
      this.punchAction.clampWhenFinished = true;
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
