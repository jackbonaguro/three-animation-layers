import {
  AnimationClip,
  Interpolant,
  LinearInterpolant,
  LoopRepeat,
  LoopPingPong,
} from 'three';

const WRAP_AROUND = 2402;
const ZERO_CURVATURE = 2400;

/**
 * Playback controller for a single {@link AnimationClip} within an
 * {@link AnimationLayer}.  Handles timing, looping, and per-track
 * interpolant evaluation.
 *
 * Conceptually similar to Three's {@link AnimationAction} but decoupled
 * from the mixer's accumulation model so the layer compositor can blend
 * per-bone across layers.
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

  private _interpolants: Interpolant[];
  private _interpolantSettings: { endingStart: number; endingEnd: number };
  private _loopCount = 0;
  private _trackIndexMap: Map<string, number>;

  constructor(clip: AnimationClip) {
    this.clip = clip;
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
      // Pass undefined so the Interpolant base class allocates its own
      // result buffer (passing null would be stored literally).
      const interp: Interpolant = (t as any).createInterpolant(undefined);
      (interp as any).settings = this._interpolantSettings;
      return interp;
    });
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
    return this;
  }

  reset(): this {
    this.time = 0;
    this.paused = false;
    this.enabled = true;
    this._loopCount = 0;
    return this;
  }

  getTrackIndex(name: string): number {
    return this._trackIndexMap.get(name) ?? -1;
  }

  /** Read the sampled value for a track after {@link _advance} has been called. */
  getTrackValue(trackIndex: number): ArrayLike<number> {
    return this._interpolants[trackIndex].resultBuffer;
  }

  /**
   * Advance playback time by `dt` seconds and evaluate every track
   * interpolant at the resulting clip-local time.
   */
  _advance(dt: number): void {
    if (this.paused || !this.enabled) return;

    const duration = this.clip.duration;
    if (duration === 0) {
      for (let i = 0; i < this._interpolants.length; i++) {
        this._interpolants[i].evaluate(0);
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

    for (let i = 0; i < this._interpolants.length; i++) {
      this._interpolants[i].evaluate(clipTime);
    }
  }

  private _updateEndings(atStart: boolean, atEnd: boolean): void {
    this._interpolantSettings.endingStart = atStart ? ZERO_CURVATURE : WRAP_AROUND;
    this._interpolantSettings.endingEnd = atEnd ? ZERO_CURVATURE : WRAP_AROUND;
  }
}
