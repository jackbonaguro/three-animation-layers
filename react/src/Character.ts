import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader';
import { AnimationLayerMixer, AnimationLayerAction, BlendTree1D, AnimationLayerMask } from './animation';
import { SkeletonHelper } from 'three';

export type PlayerClips = {
  tposeClip?: THREE.AnimationClip;
  idleClip?: THREE.AnimationClip;
  runningClip?: THREE.AnimationClip;
  punchClip?: THREE.AnimationClip;
  walkingClip?: THREE.AnimationClip;
};

/**
 * Animated character: rig root, {@link AnimationLayerMixer}, and layered clip setup.
 */
export default class Character {
  readonly rig: THREE.Object3D;
  readonly mixer: AnimationLayerMixer;

  /**
   * Blend parameter smoothing time constant (seconds). ~63% of the gap closes
   * each τ; lower = snappier.
   */
  static readonly LOCOMOTION_SPEED_SMOOTHING = 0.2;

  private locomotionBlend: BlendTree1D | null = null;
  private idleAction: AnimationLayerAction | null = null;
  private walkingAction: AnimationLayerAction | null = null;
  private runningAction: AnimationLayerAction | null = null;
  private punchAction: AnimationLayerAction | null = null;
  /** Keyboard / gameplay target in [0, 1]. */
  private _locomotionSpeedTarget = 0;
  /** Smoothed value passed to {@link BlendTree1D#updateWeights}. */
  private _locomotionSpeed = 0;

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
    const tau = Character.LOCOMOTION_SPEED_SMOOTHING;
    if (tau > 0 && deltaSeconds > 0) {
      const k = 1 / tau;
      const t = 1 - Math.exp(-k * deltaSeconds);
      this._locomotionSpeed = THREE.MathUtils.lerp(
        this._locomotionSpeed,
        this._locomotionSpeedTarget,
        t,
      );
    } else {
      this._locomotionSpeed = this._locomotionSpeedTarget;
    }

    this.locomotionBlend?.updateWeights(this._locomotionSpeed);
    this.applyLocomotionPhaseTimeScale();
    this.mixer.update(deltaSeconds);
  }

  /**
   * Walk/run are synced to idle's cycle phase, so only idle's clock advances the
   * whole locomotion stack. Scale that root so full run matches the run clip's
   * natural rate (idle/run duration ratio), while idle stays ~1x: smoothed
   * {@link _locomotionSpeed} lingers near 0 for a long time, and raw
   * `s * cadenceMul` would drag the shared clock to a crawl even when the blend
   * is still almost entirely idle.
   */
  private applyLocomotionPhaseTimeScale(): void {
    if (!this.idleAction) return;
    const s = this._locomotionSpeed;
    if (s <= 0) {
      this.idleAction.setEffectiveTimeScale(1);
      return;
    }
    const dIdle = this.idleAction.clip.duration;
    const dRun = this.runningAction?.clip.duration ?? dIdle;
    const cadenceMul =
      dIdle > 0 && dRun > 0 ? dIdle / dRun : 1;
    const motionTs = s * cadenceMul;
    // Same idle→walk edge as BlendTree1D thresholds [0, 0.5, 1]: idle weight is
    // (0.5 - s) / 0.5 on [0, 0.5], 0 after.
    const idleW = s >= 0.5 ? 0 : (0.5 - s) / 0.5;
    const ts = THREE.MathUtils.lerp(motionTs, 1, idleW);
    this.idleAction.setEffectiveTimeScale(ts);
  }

  /**
   * Sets the locomotion blend target (0 idle, 0.5 punch, 1 run). The value
   * actually used by the blend tree eases toward this each frame.
   */
  setLocomotionSpeed(speed: number): void {
    this._locomotionSpeedTarget = speed;
  }

  /** Load an FBX rig (scale, shadows), extract clips, and construct the player. */
  static async loadFromFbx(
    url = './character.fbx',
    scale = 0.05,
  ): Promise<Character> {
    const rig = await Character.loadFbxRig(url, scale);
    const walking = await Character.loadFbxRig('./Walking.fbx', scale);
    const clips = Character.extractClipsFromRig(rig);
    const { walkingClip } = Character.extractClipsFromRig(walking);
    const mergedClips = {
      ...clips,
      walkingClip,
    };
    return new Character(rig, mergedClips);
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
    // console.log(rig.animations);
    return {
      tposeClip: Character.nameToClip(rig, 'TPose'),
      idleClip: Character.nameToClip(rig, 'Idle'),
      runningClip: Character.nameToClip(rig, 'Running'),
      punchClip: Character.nameToClip(rig, 'Punch_1'),
      walkingClip: Character.nameToClip(rig, 'mixamo.com'),
    };
  }

  private setupAnimationLayers(clips: PlayerClips): void {
    const baseLayer = this.mixer.addLayer('base');

    if (clips.idleClip) {
      this.idleAction = baseLayer.clipAction(clips.idleClip);
      this.idleAction.play();
    }
    if (clips.walkingClip) {
      this.walkingAction = baseLayer.clipAction(clips.walkingClip);
      // this.walkingAction.loop = THREE.LoopRepeat;
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

      // Mesh-space: the punch keeps the clip's own facing even while the base layer turns the hips.
      const overlayLayer = this.mixer.addLayer('overlay', { mask: upperBodyMask, blendMode: 'override', blendSpace: 'mesh' });
      this.punchAction = overlayLayer.clipAction(clips.punchClip);
      this.punchAction.loop = THREE.LoopOnce;
      this.punchAction.clampWhenFinished = true;
    }


    if (this.idleAction && this.walkingAction && this.runningAction) {
      this.locomotionBlend = new BlendTree1D(
        [this.idleAction, this.walkingAction, this.runningAction],
        [0, 0.5, 1],
      );
      this.locomotionBlend.updateWeights(0);
    }
  }

  private static nameToClip(
    fbx: THREE.Object3D,
    name: string,
  ): THREE.AnimationClip | undefined {
    console.log(fbx.animations.map((a) => a.name));
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
      const v = hipsPositionTrack.values;
      for (let i = 0; i < v.length; i++) {
        if (i % 3 !== 1) {
          v[i] = 0;
        }
      }
      const y0 = v[1];
      for (let i = 1; i < v.length; i += 3) {
        v[i] -= y0;
      }
      filteredTracks.push(hipsPositionTrack);
    }
    clip.tracks = filteredTracks;
    return clip;
  }
}
