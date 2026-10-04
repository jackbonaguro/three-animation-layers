import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader';
import { AnimationLayerMixer, AnimationLayerAction, AnimationBlendTree2D, AnimationLayerMask } from './animation';
import { SkeletonHelper } from 'three';
import { DampedValue } from './DampedValue';

const ATTACK_CLIP_NAME = 'Swing';

type CharacterOptions = {
  locomotion?: boolean;
  attack?: boolean;
  meshSpace?: boolean;
} | undefined;

/**
 * Animated character: rig root, {@link AnimationLayerMixer}, and layered clip setup.
 */
export default class Character {
  /** Duration (seconds) for layer fade-in / fade-out transitions. */
  static readonly FADE_SECONDS = 0.15;

  readonly rig: THREE.Object3D;
  readonly skeletonHelper: SkeletonHelper;
  readonly mixer: AnimationLayerMixer;

  readonly options: CharacterOptions;

  /**
   * Blend parameter smoothing time constant (seconds). ~63% of the gap closes
   * each τ; lower = snappier.
   */
  static readonly LOCOMOTION_SPEED_SMOOTHING = 0.2;

  /** Magnitude of the (forward, strafe) target while walking. Matches the walk threshold's distance from idle. */
  static readonly WALK_SPEED = 0.5;
  /** Magnitude of the (forward, strafe) target while sprinting. Matches the run threshold's distance from idle. */
  static readonly RUN_SPEED = 1;

  private locomotionBlend: AnimationBlendTree2D | null = null;
  private idleAction: AnimationLayerAction | null = null;
  private walkingAction: AnimationLayerAction | null = null;
  private runningAction: AnimationLayerAction | null = null;
  private strafeLeftAction: AnimationLayerAction | null = null;
  private strafeRightAction: AnimationLayerAction | null = null;

  private attackAction: AnimationLayerAction | null = null;
  /** Attack outro: avoid scheduling fadeOut(remaining) more than once per swing. */
  private _attackEndFadeScheduled = false;

  /**
   * Movement angle (radians) in the locomotion plane: 0 = forward, +π/2 = right,
   * −π/2 = left. `null` = not moving (stationary regardless of {@link _sprinting}).
   */
  private _movementDirection: number | null = null;
  /** When true, movement uses {@link RUN_SPEED} instead of {@link WALK_SPEED}. */
  private _sprinting = false;

  /** Smoothed forward component, fed into {@link AnimationBlendTree2D#updateWeights} x. */
  private _locomotionVelocityY = new DampedValue(0, Character.LOCOMOTION_SPEED_SMOOTHING);
  /** Smoothed strafe component, fed into {@link AnimationBlendTree2D#updateWeights} y. */
  private _locomotionVelocityX = new DampedValue(0, Character.LOCOMOTION_SPEED_SMOOTHING);

  constructor(rig: THREE.Object3D, clips: Record<string, THREE.AnimationClip>, options?: CharacterOptions) {
    this.rig = rig;
    this.skeletonHelper = new SkeletonHelper(rig);
    this.mixer = new AnimationLayerMixer(rig);
    this.options = options ?? {};
    this.setupAnimationLayers(clips);
  }

  addToScene(scene: THREE.Scene): void {
    const object3D = new THREE.Object3D();

    object3D.add(this.rig);
    object3D.add(this.skeletonHelper);

    const textLabel = this.createTextLabel(this.rig);
    if (textLabel) {
      object3D.add(textLabel);
    }

    scene.add(object3D);
  }

  createTextLabel(rig: THREE.Object3D): THREE.Sprite | null {
    const canvas = document.createElement( 'canvas' );
    canvas.width = 256;
    canvas.height = 256;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.font = '32px Helvetica';

    const locomotionEnabled = (typeof this.options?.locomotion !== 'boolean' || this.options.locomotion === true);
    const attackEnabled = (typeof this.options?.attack !== 'boolean' || this.options.attack === true);
    const meshSpace = (typeof this.options?.meshSpace === 'boolean' && this.options.meshSpace === true);

    context.fillText('Character', 0, 32);
    context.fillText(`Locomotion: ${locomotionEnabled ? '🟢' : '🔴'}`, 0, 64);
    context.fillText(`Attack: ${attackEnabled ? '🟢' : '🔴'}`, 0, 96);
    context.fillText(`Mesh Space: ${meshSpace ? '🟢' : '🔴'}`, 0, 128);

    const texture = new THREE.CanvasTexture( canvas );
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
    const textLabel = new THREE.Sprite(material);

    textLabel.scale.set(10, 10, 1);
    textLabel.position.set(rig.position.x, -15, 0);

    return textLabel;
  }

  update(deltaSeconds: number): void {
    if (this._movementDirection !== null) {
      const magnitude = this._sprinting ? Character.RUN_SPEED : Character.WALK_SPEED;
      this._locomotionVelocityY.target = Math.cos(this._movementDirection) * magnitude;
      this._locomotionVelocityX.target = Math.sin(this._movementDirection) * magnitude;
    } else {
      this._locomotionVelocityY.target = 0;
      this._locomotionVelocityX.target = 0;
    }
    this._locomotionVelocityY.update(deltaSeconds);
    this._locomotionVelocityX.update(deltaSeconds);

    this.locomotionBlend?.updateWeights(
      new THREE.Vector2(this._locomotionVelocityY.value, this._locomotionVelocityX.value),
    );
    this.applyLocomotionPhaseTimeScale();

    this.syncAttackOutroFade();

    this.mixer.update(deltaSeconds);

    this.syncAttackOutroFade();
  }

  /**
   * Walk/run are synced to idle's cycle phase, so only idle's clock advances the
   * whole locomotion stack. Scale that root so full run matches the run clip's
   * natural rate (idle/run duration ratio), while idle stays ~1x: smoothed
   * {@link _locomotionVelocityY} lingers near 0 for a long time, and raw
   * `s * cadenceMul` would drag the shared clock to a crawl even when the blend
   * is still almost entirely idle.
   */
  private applyLocomotionPhaseTimeScale(): void {
    if (!this.idleAction) return;
    const s = Math.hypot(this._locomotionVelocityY.value, this._locomotionVelocityX.value);
    if (s <= 0) {
      this.idleAction.setEffectiveTimeScale(1);
      return;
    }
    const dIdle = this.idleAction.clip.duration;
    const dRun = this.runningAction?.clip.duration ?? dIdle;
    const cadenceMul =
      dIdle > 0 && dRun > 0 ? dIdle / dRun : 1;
    const motionTs = s * cadenceMul;
    // Match the old BlendTree1D edge: idle weight is (0.5 - s) / 0.5 on
    // [0, 0.5], 0 after. Generalises naturally to magnitude since both walk
    // and the (now matching-magnitude) strafe thresholds sit at length 0.5.
    const idleW = s >= 0.5 ? 0 : (0.5 - s) / 0.5;
    const ts = THREE.MathUtils.lerp(motionTs, 1, idleW);
    this.idleAction.setEffectiveTimeScale(ts);
  }

  /**
   * Sets the movement direction in radians (0 = forward, +π/2 = right,
   * −π/2 = left). Pass `null` to stop moving (idle). The smoothed
   * (forward, strafe) components fed into the blend tree are derived from
   * this and {@link _sprinting} each frame in {@link update}.
   */
  setMovementDirection(radians: number | null): void {
    this._movementDirection = radians;
  }

  /** Toggles the sprint modifier. Direction is unchanged. */
  setSprinting(sprinting: boolean): void {
    this._sprinting = sprinting;
  }

  /** Load an FBX rig (scale, shadows), extract clips, and construct the player. */
  static async loadFromFbx(
    options?: {
      locomotion?: boolean;
      attack?: boolean;
      meshSpace?: boolean;
    },
    url = './character.fbx',
    scale = 0.05,
  ): Promise<Character> {
    const rig = await Character.loadFbxRig(url, scale);
    const clips = Character.extractClipsFromRig(rig);
    return new Character(rig, clips, options);
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
  static extractClipsFromRig(rig: THREE.Object3D): Record<string, THREE.AnimationClip> {
    const clipNames = ['Idle', 'Running', 'Walking', 'Strafe_Left', 'Strafe_Right', ATTACK_CLIP_NAME];
    const clips: Record<string, THREE.AnimationClip> = {};
    for (const name of clipNames) {
      const clip = Character.nameToClip(rig, name);
      if (clip) {
        clips[name] = clip;
      }
    }
    return clips;
  }

  triggerAttack(): void {
    if (!this.attackAction) return;
    this._attackEndFadeScheduled = false;
    this.attackAction.reset();
    this.attackAction.fadeIn(Character.FADE_SECONDS);
  }

  /**
   * When local time is within {@link FADE_SECONDS} of the clip end, call
   * `fadeOut(remaining)` so the fade finishes as the clip finishes. If we are
   * already parked on the last frame (`remaining === 0`), fade over
   * {@link FADE_SECONDS} on the held pose (large-dt fallback).
   */
  private syncAttackOutroFade(): void {
    const a = this.attackAction;
    if (!a || !a.enabled || this._attackEndFadeScheduled) return;
    const dur = a.clip.duration;
    if (dur <= 0) return;
    const fade = Character.FADE_SECONDS;
    const remaining = Math.max(0, dur - a.time);
    if (remaining > fade + 1e-6) return;
    const outDuration = remaining > 1e-6 ? remaining : fade;
    a.fadeOut(outDuration);
    this._attackEndFadeScheduled = true;
  }

  private setupAnimationLayers(clips: Record<string, THREE.AnimationClip>): void {
    const locomotionEnabled = (typeof this.options?.locomotion !== 'boolean' || this.options.locomotion === true);

    // Base layer. Idle always plays at full weight so every bone has a real pose
    // underneath the upper layers (otherwise fades blend to/from the mixer's
    // rest-pose snapshot, i.e. whatever pose the FBX happened to load in).
    const baseLayer = this.mixer.addLayer('base');
    if (clips['Idle']) {
      this.idleAction = baseLayer.clipAction(clips['Idle']);
      this.idleAction.play();
    }

    if (locomotionEnabled) {
      // Foot locomotion
      if (clips['Walking']) {
        this.walkingAction = baseLayer.clipAction(clips['Walking']);
      }
      if (clips['Running']) {
        this.runningAction = baseLayer.clipAction(clips['Running']);
      }
      if (clips['Strafe_Left']) {
        this.strafeLeftAction = baseLayer.clipAction(clips['Strafe_Left']);
      }
      if (clips['Strafe_Right']) {
        this.strafeRightAction = baseLayer.clipAction(clips['Strafe_Right']);
      }

      // Blend space is a (forward, strafe) velocity vector. Each threshold sits
      // at the velocity its clip is authored for:
      //   idle    (0,    0)    – stationary
      //   walk    (0.5,  0)    – forward at walk speed
      //   run    (1,    0)    – forward at run speed
      //   strafe ±(0, 0.5)    – sideways at walk speed (the clips' authored pace)
      // Walk and strafe sit at the same magnitude (0.5) so a pure A maps to its
      // strafe threshold cleanly and W+A produces a real diagonal blend.
      if (
        this.idleAction &&
        this.walkingAction &&
        this.runningAction &&
        this.strafeLeftAction &&
        this.strafeRightAction
      ) {
        this.locomotionBlend = new AnimationBlendTree2D(
          [
            this.idleAction,
            this.walkingAction,
            this.runningAction,
            this.strafeLeftAction,
            this.strafeRightAction,
          ],
          [
            new THREE.Vector2(0, 0),
            new THREE.Vector2(0.5, 0),
            new THREE.Vector2(1, 0),
            new THREE.Vector2(0, -0.5),
            new THREE.Vector2(0, 0.5),
          ],
        );
      }
    }

    if (clips[ATTACK_CLIP_NAME]) {
      if (!this.options || (typeof this.options.attack !== 'boolean' || this.options.attack)) {
        const upperBodyMask = new AnimationLayerMask({
          'mixamorigSpine.quaternion': 0.25,
          'mixamorigSpine1.quaternion': 0.5,
          'mixamorigSpine2.quaternion': 0.75,
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

        // Mesh-space: the attack keeps the clip's own facing even while the base layer turns the hips.
        const blendSpace = this.options?.meshSpace ? 'mesh' : 'local';
        // With locomotion off there is nothing to preserve below the waist, so play the attack full-body.
        const mask = locomotionEnabled ? upperBodyMask : null;
        const upperBodyLayer = this.mixer.addLayer('upperBody', { mask, blendMode: 'override', blendSpace });
        this.attackAction = upperBodyLayer.clipAction(clips[ATTACK_CLIP_NAME]);
        this.attackAction.loop = THREE.LoopOnce;
        this.attackAction.clampWhenFinished = true;
        this.attackAction.setDuration(clips[ATTACK_CLIP_NAME].duration / 2);
      }
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
