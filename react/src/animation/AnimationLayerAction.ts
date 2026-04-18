import {
  AnimationClip,
  Interpolant,
  LinearInterpolant,
  LoopRepeat,
  LoopPingPong,
  WrapAroundEnding,
  ZeroCurvatureEnding,
} from 'three';
import type { AnimationLayerMixer } from './AnimationLayerMixer';

/**
 * Playback controller for a single {@link AnimationClip} within an
 * {@link AnimationLayer}.  Handles timing, looping, per-track interpolant
 * evaluation, and weight fading.
 *
 * Weight fading follows the same pattern as Three's `AnimationAction`:
 * {@link fadeIn} / {@link fadeOut} schedule a linear interpolant in the owning
 * mixer's global time; when a fade-out completes at zero influence the action
 * is automatically disabled.
 */
export class AnimationLayerAction {
  readonly clip: AnimationClip;
  readonly trackNames: string[];
  readonly trackValueTypes: string[];
  readonly trackValueSizes: number[];

  time = 0;
  timeScale = 1;
  weight = 1;
  enabled = false;
  paused = false;
  loop: number = LoopRepeat;
  repetitions = Infinity;
  clampWhenFinished = false;

  private _mixer: AnimationLayerMixer;
  private _interpolants: Interpolant[];
  private _interpolantSettings: { endingStart: number; endingEnd: number };
  private _loopCount = 0;
  private _trackIndexMap: Map<string, number>;

  private _weightInterpolant: LinearInterpolant | null = null;
  private _timeScaleInterpolant: LinearInterpolant | null = null;
  private _effectiveWeight = 0;

  private _startTime: number | null = null;
  private _syncTarget: AnimationLayerAction | null = null;

  /** @internal Set by AnimationLayer when the action is added/removed. */
  _isScheduled = false;

  constructor(clip: AnimationClip, mixer: AnimationLayerMixer) {
    this.clip = clip;
    this._mixer = mixer;
    const tracks = clip.tracks;

    this.trackNames = tracks.map((t) => t.name);
    this.trackValueTypes = tracks.map((t) => t.ValueTypeName);
    this.trackValueSizes = tracks.map((t) => t.getValueSize());

    this._trackIndexMap = new Map<string, number>();
    for (let i = 0; i < tracks.length; i++) {
      this._trackIndexMap.set(tracks[i].name, i);
    }

    this._interpolantSettings = {
      endingStart: WrapAroundEnding,
      endingEnd: WrapAroundEnding,
    };

    this._interpolants = tracks.map((t) => {
      const interp: Interpolant = (t as any).createInterpolant(undefined);
      (interp as any).settings = this._interpolantSettings;
      return interp;
    });

    this._effectiveWeight = this.enabled ? this.weight : 0;
  }

  // ---------------------------------------------------------------------------
  //  Accessors
  // ---------------------------------------------------------------------------

  getMixer(): AnimationLayerMixer {
    return this._mixer;
  }

  getRoot() {
    return this._mixer.root;
  }

  getEffectiveWeight(): number {
    return this._effectiveWeight;
  }

  /** Sets {@link weight} and clears any active fade. */
  setEffectiveWeight(w: number): this {
    this.weight = w;
    this._effectiveWeight = this.enabled ? w : 0;
    return this.stopFading();
  }

  /**
   * Returns the current effective time scale, accounting for any active
   * {@link warp} curve.  Zero when the action is {@link paused}.
   */
  getEffectiveTimeScale(): number {
    if (this.paused) return 0;
    return this._computeEffectiveTimeScale(this._mixer.time);
  }

  /**
   * Sets {@link timeScale} and clears any active {@link warp}.
   * Effective time scale is zero while {@link paused}, regardless of this value.
   */
  setEffectiveTimeScale(timeScale: number): this {
    this.timeScale = timeScale;
    return this.stopWarping();
  }

  /**
   * Adjusts {@link timeScale} so the clip plays back in exactly `duration`
   * seconds, then clears any active {@link warp}.
   */
  setDuration(duration: number): this {
    this.timeScale = this.clip.duration / duration;
    return this.stopWarping();
  }

  /**
   * Re-derives {@link getEffectiveWeight} from `enabled`, {@link weight}, and
   * any scheduled fade curve. Call this after setting `enabled` directly if you
   * need a correct value before the next {@link AnimationLayerMixer#update}.
   */
  syncEffectiveWeight(mixerTime: number): void {
    this._updateWeight(mixerTime);
  }

  // ---------------------------------------------------------------------------
  //  State queries
  // ---------------------------------------------------------------------------

  /**
   * Returns `true` when the action is currently advancing: enabled, not paused,
   * not waiting for a {@link startAt} delay, and has a non-zero time scale.
   */
  isRunning(): boolean {
    return (
      this.enabled &&
      !this.paused &&
      this.timeScale !== 0 &&
      this._startTime === null
    );
  }

  /**
   * Returns `true` as long as the action belongs to an {@link AnimationLayer}
   * (i.e. has not been removed via {@link AnimationLayer.removeAction}).
   */
  isScheduled(): boolean {
    return this._isScheduled;
  }

  // ---------------------------------------------------------------------------
  //  Playback control
  // ---------------------------------------------------------------------------

  play(): this {
    this.enabled = true;
    this.paused = false;
    return this;
  }

  pause(): this {
    this.paused = true;
    return this;
  }

  stop(): this {
    this.enabled = false;
    this.time = 0;
    this._loopCount = 0;
    this._effectiveWeight = 0;
    this._startTime = null;
    this._syncTarget = null;
    return this.stopFading().stopWarping();
  }

  reset(): this {
    this.time = 0;
    this.paused = false;
    this.enabled = true;
    this._loopCount = 0;
    this._startTime = null;
    return this.stopFading();
  }

  /**
   * Defers playback until the mixer's global time reaches `mixerTime`.
   * The action must already be enabled; call {@link play} first if needed.
   */
  startAt(mixerTime: number): this {
    this._startTime = mixerTime;
    return this;
  }

  /** Sets both {@link loop} mode and {@link repetitions} in one call. */
  setLoop(mode: number, repetitions: number): this {
    this.loop = mode;
    this.repetitions = repetitions;
    return this;
  }

  // ---------------------------------------------------------------------------
  //  Weight fading
  // ---------------------------------------------------------------------------

  fadeIn(duration: number): this {
    return this._scheduleFade(duration, 0, 1);
  }

  fadeOut(duration: number): this {
    return this._scheduleFade(duration, 1, 0);
  }

  stopFading(): this {
    if (this._weightInterpolant !== null) {
      this._mixer._takeBackControlInterpolant(this._weightInterpolant);
      this._weightInterpolant = null;
    }
    return this;
  }

  // ---------------------------------------------------------------------------
  //  Time-scale warping
  // ---------------------------------------------------------------------------

  /**
   * Linearly ramps {@link timeScale} from `startTimeScale` to `endTimeScale`
   * over `duration` seconds.  When the ramp completes the final value is baked
   * into {@link timeScale} and the warp is cleared.
   */
  warp(startTimeScale: number, endTimeScale: number, duration: number): this {
    return this._scheduleTimeScale(duration, startTimeScale, endTimeScale);
  }

  stopWarping(): this {
    if (this._timeScaleInterpolant !== null) {
      this._mixer._takeBackControlInterpolant(this._timeScaleInterpolant);
      this._timeScaleInterpolant = null;
    }
    return this;
  }

  /**
   * Fades the effective time scale to zero over `duration` seconds, freezing
   * the action in place (equivalent to `warp(currentTimeScale, 0, duration)`).
   */
  halt(duration: number): this {
    return this._scheduleTimeScale(duration, this.getEffectiveTimeScale(), 0);
  }

  // ---------------------------------------------------------------------------
  //  Synchronisation & cross-fading
  // ---------------------------------------------------------------------------

  /**
   * Locks this action's {@link time} to `action`'s each frame so both clips
   * evaluate at the same position regardless of independent weights.
   * Pass `null` to detach.
   */
  syncWith(action: AnimationLayerAction | null): this {
    this._syncTarget = action;
    return this;
  }

  /**
   * Fades `fadeOutAction` out and fades this action in over `duration` seconds.
   *
   * Pass `warp = true` to also ramp each action's time scale so clips of
   * different lengths stay aligned at both endpoints of the crossfade.
   */
  crossFadeFrom(fadeOutAction: AnimationLayerAction, duration: number, warp = false): this {
    fadeOutAction.fadeOut(duration);
    this.fadeIn(duration);

    if (warp) {
      const fromDuration = fadeOutAction.clip.duration;
      const toDuration = this.clip.duration;
      fadeOutAction.warp(1, fromDuration / toDuration, duration);
      this.warp(toDuration / fromDuration, 1, duration);
    }

    return this;
  }

  /** Convenience inverse of {@link crossFadeFrom}. */
  crossFadeTo(fadeInAction: AnimationLayerAction, duration: number, warp = false): this {
    this.fadeOut(duration);
    fadeInAction.fadeIn(duration);

    if (warp) {
      const fromDuration = this.clip.duration;
      const toDuration = fadeInAction.clip.duration;
      this.warp(1, fromDuration / toDuration, duration);
      fadeInAction.warp(toDuration / fromDuration, 1, duration);
    }

    return this;
  }

  // ---------------------------------------------------------------------------
  //  Track access (used by AnimationLayer)
  // ---------------------------------------------------------------------------

  getTrackIndex(name: string): number {
    return this._trackIndexMap.get(name) ?? -1;
  }

  getTrackValue(trackIndex: number): ArrayLike<number> {
    return this._interpolants[trackIndex].resultBuffer;
  }

  // ---------------------------------------------------------------------------
  //  Internal update (called by AnimationLayer._sample each frame)
  // ---------------------------------------------------------------------------

  /** @internal Called each frame by {@link AnimationLayer._sample}. */
  _advance(dt: number, mixerTime: number): void {
    if (!this.enabled) {
      this._updateWeight(mixerTime);
      return;
    }

    // Delayed start: hold until the mixer's global clock reaches _startTime.
    if (this._startTime !== null) {
      if (mixerTime < this._startTime) {
        this._updateWeight(mixerTime);
        return;
      }
      this._startTime = null;
    }

    if (this.paused) {
      this._updateWeight(mixerTime);
      return;
    }

    // Synced actions mirror another action's time position instead of advancing
    // independently, keeping both clips evaluated at the same point each frame.
    if (this._syncTarget !== null) {
      this.time = this._syncTarget.time;
      this._updateWeight(mixerTime);
      if (this._effectiveWeight > 0) {
        for (let i = 0; i < this._interpolants.length; i++) {
          this._interpolants[i].evaluate(this.time);
        }
      }
      return;
    }

    const duration = this.clip.duration;

    if (duration === 0) {
      this._updateWeight(mixerTime);
      if (this._effectiveWeight > 0) {
        for (let i = 0; i < this._interpolants.length; i++) {
          this._interpolants[i].evaluate(0);
        }
      }
      return;
    }

    const effectiveTS = this._computeEffectiveTimeScale(mixerTime);
    this.time += dt * effectiveTS;
    let clipTime = this.time;

    if (this.loop === LoopRepeat || this.loop === LoopPingPong) {
      if (clipTime < 0 || clipTime >= duration) {
        const loopDelta = Math.floor(clipTime / duration);
        clipTime -= duration * loopDelta;
        const absLoopDelta = Math.abs(loopDelta);
        this._loopCount += absLoopDelta;

        if (this._loopCount >= this.repetitions) {
          clipTime = effectiveTS >= 0 ? duration : 0;
          if (this.clampWhenFinished) this.paused = true;
          else this.enabled = false;
          this._updateEndings(true, true);
        } else {
          this._updateEndings(false, false);
        }
      } else {
        this._updateEndings(false, false);
      }

      if (this.loop === LoopPingPong && (this._loopCount & 1) === 1) {
        clipTime = duration - clipTime;
      }
    } else {
      // LoopOnce
      this._updateEndings(true, true);
      if (clipTime >= duration) {
        clipTime = duration;
        if (this.clampWhenFinished) this.paused = true;
        else this.enabled = false;
      } else if (clipTime < 0) {
        clipTime = 0;
        if (this.clampWhenFinished) this.paused = true;
        else this.enabled = false;
      }
    }

    this._updateWeight(mixerTime);

    if (this._effectiveWeight <= 0) return;

    for (let i = 0; i < this._interpolants.length; i++) {
      this._interpolants[i].evaluate(clipTime);
    }
  }

  // ---------------------------------------------------------------------------
  //  Private helpers
  // ---------------------------------------------------------------------------

  private _scheduleFade(duration: number, weightNow: number, weightThen: number): this {
    const now = this._mixer.time;
    let interp = this._weightInterpolant;
    if (interp === null) {
      interp = this._mixer._lendControlInterpolant();
      this._weightInterpolant = interp;
    }
    interp.parameterPositions[0] = now;
    interp.parameterPositions[1] = now + duration;
    interp.sampleValues[0] = weightNow;
    interp.sampleValues[1] = weightThen;
    return this;
  }

  private _scheduleTimeScale(duration: number, startTS: number, endTS: number): this {
    const now = this._mixer.time;
    let interp = this._timeScaleInterpolant;
    if (interp === null) {
      interp = this._mixer._lendControlInterpolant();
      this._timeScaleInterpolant = interp;
    }
    interp.parameterPositions[0] = now;
    interp.parameterPositions[1] = now + duration;
    interp.sampleValues[0] = startTS;
    interp.sampleValues[1] = endTS;
    return this;
  }

  private _computeEffectiveTimeScale(mixerTime: number): number {
    const interp = this._timeScaleInterpolant;
    if (interp !== null) {
      const v = interp.evaluate(mixerTime)[0];
      if (mixerTime > interp.parameterPositions[1]) {
        // Bake the final value so timeScale stays at the warp endpoint.
        this.timeScale = v;
        this.stopWarping();
      }
      return v;
    }
    return this.timeScale;
  }

  private _updateWeight(time: number): void {
    let w = 0;
    if (this.enabled) {
      w = this.weight;
      const interp = this._weightInterpolant;
      if (interp !== null) {
        const v = interp.evaluate(time)[0];
        w *= v;
        if (time > interp.parameterPositions[1]) {
          this.stopFading();
          if (v === 0) this.enabled = false;
        }
      }
    }
    this._effectiveWeight = w;
  }

  private _updateEndings(atStart: boolean, atEnd: boolean): void {
    this._interpolantSettings.endingStart = atStart ? ZeroCurvatureEnding : WrapAroundEnding;
    this._interpolantSettings.endingEnd = atEnd ? ZeroCurvatureEnding : WrapAroundEnding;
  }
}
