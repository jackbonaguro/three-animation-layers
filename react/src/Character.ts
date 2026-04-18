import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader';
import { AnimationLayerMixer, AnimationLayerMask, AnimationLayer, AnimationLayerAction } from './animation';
import { SkeletonHelper } from 'three';

export type PlayerClips = {
  tposeClip?: THREE.AnimationClip;
  idleClip?: THREE.AnimationClip;
  runningClip?: THREE.AnimationClip;
  punchClip?: THREE.AnimationClip;
};

/**
 * Animated character: rig root, {@link AnimationLayerMixer}, and layered clip setup.
 */
export default class Character {
  /** Duration (seconds) for layer fade-in / fade-out transitions. */
  static readonly FADE_SECONDS = 0.15;

  readonly rig: THREE.Object3D;
  readonly mixer: AnimationLayerMixer;

  private overlayLayer: AnimationLayer | null = null;
  private punchAction: AnimationLayerAction | null = null;
  private idleAction: AnimationLayerAction | null = null;
  private runningAction: AnimationLayerAction | null = null;
  private _runningHeld = false;
  /** Punch outro: avoid scheduling fadeOut(remaining) more than once per swing. */
  private _punchEndFadeScheduled = false;

  constructor(rig: THREE.Object3D, clips: PlayerClips) {
    this.rig = rig;
    this.mixer = new AnimationLayerMixer(rig);
    this.setupAnimationLayers(clips);
  }

  addToScene(scene: THREE.Scene): void {
    scene.add(this.rig);
    const skeletonHelper = new SkeletonHelper(this.rig);
    scene.add(skeletonHelper);
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
    const fade = Character.FADE_SECONDS;
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
    this.punchAction.fadeIn(Character.FADE_SECONDS);
  }

  /**
   * While W is held: run fades in and idle fades out together (same duration).
   * On release: run fades out and idle fades in — matches a standard mixer crossfade.
   */
  setRunningHeld(held: boolean): void {
    if (!this.runningAction) return;
    if (held === this._runningHeld) return;
    this._runningHeld = held;
    const t = Character.FADE_SECONDS;
    if (held) {
      this.idleAction?.fadeOut(t);
      this.runningAction.reset();
      this.runningAction.fadeIn(t);
    } else {
      this.runningAction.fadeOut(t);
      if (this.idleAction) {
        this.idleAction.play();
        this.idleAction.fadeIn(t);
      }
    }
  }

  /** Load an FBX rig (scale, shadows), extract clips, and construct the player. */
  static async loadFromFbx(
    url = './character.fbx',
    scale = 0.05,
  ): Promise<Character> {
    const rig = await Character.loadFbxRig(url, scale);
    const clips = Character.extractClipsFromRig(rig);
    return new Character(rig, clips);
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
      tposeClip: Character.nameToClip(rig, 'TPose'),
      idleClip: Character.nameToClip(rig, 'Idle'),
      runningClip: Character.nameToClip(rig, 'Running'),
      punchClip: Character.nameToClip(rig, 'Punch_1'),
    };
  }

  private setupAnimationLayers(clips: PlayerClips): void {
    const baseLayer = this.mixer.addLayer('base');
    if (clips.idleClip) {
      this.idleAction = baseLayer.clipAction(clips.idleClip);
      this.idleAction.play();
    }
    if (clips.runningClip) {
      this.runningAction = baseLayer.clipAction(clips.runningClip);
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
      this.punchAction = this.overlayLayer.clipAction(clips.punchClip);
      this.punchAction.loop = THREE.LoopOnce;
      this.punchAction.clampWhenFinished = true;
    }
  }

  private static nameToClip(
    fbx: THREE.Object3D,
    name: string,
  ): THREE.AnimationClip | undefined {
    let clip = fbx.animations.find((a) => a.name.includes(name))?.clone();
    if (!clip) return;
    clip = Character.normalizeClip(clip);
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
