import {
  AnimationClip,
  Interpolant,
  LinearInterpolant,
  LoopRepeat,
  LoopPingPong,
} from 'three';
import type { LayeredMixer } from './LayeredMixer';

const WRAP_AROUND = 2402;
const ZERO_CURVATURE = 2400;

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
export class LayerAction {
  readonly clip: AnimationClip;
  readonly trackNames: string[];
  readonly trackValueTypes: string[];
  readonly trackValueSizes: number[];

  time = 0;
  timeScale = 1;
  weight = 1;
  enabled = true;
  paused = false;
  loop: number = LoopRepeat;
  repetitions = Infinity;
  clampWhenFinished = false;

  private _mixer: LayeredMixer;
  private _interpolants: Interpolant[];
  private _interpolantSettings: { endingStart: number; endingEnd: number };
  private _loopCount = 0;
  private _trackIndexMap: Map<string, number>;

  private _weightInterpolant: LinearInterpolant | null = null;
  private _effectiveWeight = 0;

  constructor(clip: AnimationClip, mixer: LayeredMixer) {
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
      endingStart: WRAP_AROUND,
      endingEnd: WRAP_AROUND,
    };

    this._interpolants = tracks.map((t) => {
      const interp: Interpolant = (t as any).createInterpolant(undefined);
      (interp as any).settings = this._interpolantSettings;
      return interp;
    });

    this._effectiveWeight = this.enabled ? this.weight : 0;
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
   * Re-derives {@link getEffectiveWeight} from `enabled`, {@link weight}, and
   * any scheduled fade curve. Call this after setting `enabled` directly if you
   * need a correct value before the next {@link LayeredMixer#update}.
   */
  syncEffectiveWeight(mixerTime: number): void {
    this._updateWeight(mixerTime);
  }

  play(): this {
    this.enabled = true;
    this.paused = false;
    return this;
  }

  stop(): this {
    this.enabled = false;
    this.time = 0;
    this._loopCount = 0;
    this._effectiveWeight = 0;
    return this.stopFading();
  }

  reset(): this {
    this.time = 0;
    this.paused = false;
    this.enabled = true;
    this._loopCount = 0;
    return this.stopFading();
  }

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

  getTrackIndex(name: string): number {
    return this._trackIndexMap.get(name) ?? -1;
  }

  getTrackValue(trackIndex: number): ArrayLike<number> {
    return this._interpolants[trackIndex].resultBuffer;
  }

  /** @internal Called each frame by {@link AnimationLayer._sample}. */
  _advance(dt: number, mixerTime: number): void {
    // Always resolve the effective weight first (handles fade completion /
    // auto-disable when a fade-out reaches 0).
    if (!this.enabled) {
      this._updateWeight(mixerTime);
      return;
    }

    if (this.paused) {
      this._updateWeight(mixerTime);
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

    this.time += dt * this.timeScale;
    let clipTime = this.time;

    if (this.loop === LoopRepeat || this.loop === LoopPingPong) {
      if (clipTime < 0 || clipTime >= duration) {
        const loopDelta = Math.floor(clipTime / duration);
        clipTime -= duration * loopDelta;
        this._loopCount += Math.abs(loopDelta);

        if (this._loopCount >= this.repetitions) {
          clipTime = dt > 0 ? duration : 0;
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

    // Skip evaluation when this action has no influence.
    if (this._effectiveWeight <= 0) return;

    for (let i = 0; i < this._interpolants.length; i++) {
      this._interpolants[i].evaluate(clipTime);
    }
  }

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
    this._interpolantSettings.endingStart = atStart ? ZERO_CURVATURE : WRAP_AROUND;
    this._interpolantSettings.endingEnd = atEnd ? ZERO_CURVATURE : WRAP_AROUND;
  }
}
