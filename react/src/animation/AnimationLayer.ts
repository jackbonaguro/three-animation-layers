import { AnimationClip, Quaternion } from 'three';
import { AnimationLayerMask } from './AnimationLayerMask';
import { AnimationLayerAction } from './AnimationLayerAction';
import type { AnimationLayerMixer } from './AnimationLayerMixer';
import type { MutableLinearInterpolant } from './AnimationLayerTypes';

export type LayerBlendMode = 'override' | 'additive';

/**
 * A single priority level within a {@link AnimationLayerMixer}.
 *
 * Each layer holds one or more {@link AnimationLayerAction}s. During a mixer update
 * the layer advances all active actions, blends their per-track contributions
 * together (weighted by action weight), and exposes the result so the mixer
 * can compose across layers.
 *
 * Layers are evaluated bottom-to-top (first added = lowest priority).
 *
 * Like {@link AnimationLayerAction}, the layer itself supports weight fading via
 * {@link fadeIn} / {@link fadeOut}, backed by the same mixer interpolant pool.
 */
export class AnimationLayer {
  readonly name: string;

  /**
   * Base influence of this layer (0 = inactive, 1 = full).
   * For the value actually used each frame (which may be modified by a fade
   * curve), see {@link getEffectiveWeight}.
   */
  weight = 1;

  /**
   * Per-bone weight mask.  Bones not listed default to 0 (no influence).
   * Pass `null` for a full-body layer (every bone weight = 1).
   */
  mask: AnimationLayerMask | null;

  blendMode: LayerBlendMode;

  private _actions: AnimationLayerAction[] = [];

  // Per-track blended value buffers, keyed by track name.  Re-used across frames.
  private _sampledValues = new Map<string, Float64Array>();
  private _sampledValueTypes = new Map<string, string>();
  private _activeTrackNames = new Set<string>();
  /**
   * Total action-weight accumulated per track this frame.  Capped at 1 for use
   * as the layer's influence fraction in {@link AnimationLayerMixer._compose}.
   */
  private _sampledWeights = new Map<string, number>();
  private _mixer: AnimationLayerMixer | null = null;

  private _weightInterpolant: MutableLinearInterpolant | null = null;
  private _effectiveLayerWeight = 1;

  constructor(
    name: string,
    mask: AnimationLayerMask | null = null,
    blendMode: LayerBlendMode = 'override',
  ) {
    this.name = name;
    this.mask = mask;
    this.blendMode = blendMode;
  }

  get actions(): readonly AnimationLayerAction[] {
    return this._actions;
  }

  // ---------------------------------------------------------------------------
  //  Layer weight fading
  // ---------------------------------------------------------------------------

  /**
   * Returns the effective layer weight for the current frame, which may differ
   * from {@link weight} while a {@link fadeIn} / {@link fadeOut} is in progress.
   */
  getEffectiveWeight(): number {
    return this._effectiveLayerWeight;
  }

  /** Sets {@link weight} to `w` and cancels any active fade. */
  setEffectiveWeight(w: number): this {
    this.weight = w;
    this._effectiveLayerWeight = w;
    return this.stopFading();
  }

  /** Schedules a linear fade of the layer weight from 0 → 1 over `duration` seconds. */
  fadeIn(duration: number): this {
    return this._scheduleFade(duration, 0, 1);
  }

  /** Schedules a linear fade of the layer weight from 1 → 0 over `duration` seconds. */
  fadeOut(duration: number): this {
    return this._scheduleFade(duration, 1, 0);
  }

  stopFading(): this {
    if (this._weightInterpolant !== null) {
      this._mixer!._takeBackControlInterpolant(this._weightInterpolant);
      this._weightInterpolant = null;
    }
    return this;
  }

  // ---------------------------------------------------------------------------
  //  Action management
  // ---------------------------------------------------------------------------

  /**
   * Create a {@link AnimationLayerAction} for `clip` and add it to this layer.
   * Returns the action.
   */
  clipAction(clip: AnimationClip): AnimationLayerAction {
    if (!this._mixer) throw new Error('AnimationLayer must be added via AnimationLayerMixer.addLayer before calling play()');
    const action = new AnimationLayerAction(clip, this._mixer);
    action._isScheduled = true;
    this._actions.push(action);

    for (const track of clip.tracks) {
      if (!this._sampledValues.has(track.name)) {
        this._sampledValues.set(track.name, new Float64Array(track.getValueSize()));
        this._sampledValueTypes.set(track.name, track.ValueTypeName);
      }
    }

    if (this._mixer) {
      this._mixer.registerTracks(clip.tracks);
    }
    return action;
  }

  /**
   * Returns the first {@link AnimationLayerAction} in this layer whose clip matches
   * `clip` by reference, or `null` if none is found.
   */
  getAction(clip: AnimationClip): AnimationLayerAction | null {
    return this._actions.find((a) => a.clip === clip) ?? null;
  }

  removeAction(action: AnimationLayerAction): void {
    const idx = this._actions.indexOf(action);
    if (idx >= 0) {
      action._isScheduled = false;
      this._actions.splice(idx, 1);
    }
  }

  /** Stops all actions in this layer (equivalent to calling {@link AnimationLayerAction.stop} on each). */
  stopAllActions(): this {
    for (const action of this._actions) {
      action.stop();
    }
    return this;
  }

  // ---------------------------------------------------------------------------
  //  Per-track sampled values (read by AnimationLayerMixer._compose)
  // ---------------------------------------------------------------------------

  /**
   * Returns the blended sample for `trackName` if any active action
   * contributed to it this frame, otherwise `null`.
   */
  getSampledValue(trackName: string): Float64Array | null {
    if (!this._activeTrackNames.has(trackName)) return null;
    return this._sampledValues.get(trackName) ?? null;
  }

  getSampledValueType(trackName: string): string | undefined {
    return this._sampledValueTypes.get(trackName);
  }

  /**
   * Returns the accumulated action weight for `trackName` this frame (0–1).
   * The compositor multiplies this into the layer's blend factor so that
   * partially-faded actions reduce the layer's influence proportionally.
   */
  getSampledWeight(trackName: string): number {
    return this._sampledWeights.get(trackName) ?? 0;
  }

  // ---------------------------------------------------------------------------
  //  Internal update (called by AnimationLayerMixer.update each frame)
  // ---------------------------------------------------------------------------

  /**
   * Advance all actions by `dt` and blend their per-track contributions
   * into the layer's sample buffers.
   *
   * @internal Called by the owning {@link AnimationLayerMixer}.
   */
  _sample(dt: number, mixerTime: number): void {
    // Update this layer's effective weight before sampling so _compose sees
    // the correct value without needing a separate pass.
    this._updateEffectiveWeight(mixerTime);

    this._activeTrackNames.clear();
    this._sampledWeights.clear();

    const activeActions: AnimationLayerAction[] = [];
    for (const action of this._actions) {
      action._advance(dt, mixerTime);
      // _advance may disable the action (LoopOnce finished, or fade-out completed)
      if (action.enabled && action.getEffectiveWeight() > 0) {
        activeActions.push(action);
      }
    }

    if (activeActions.length === 0) return;

    // Collect every track name contributed by at least one active action.
    const trackSet = new Set<string>();
    for (const action of activeActions) {
      for (const name of action.trackNames) {
        trackSet.add(name);
      }
    }

    // Blend action contributions per-track using incremental weighted average.
    const trackNames = Array.from(trackSet);
    for (const trackName of trackNames) {
      const buffer = this._sampledValues.get(trackName);
      if (!buffer) continue;

      let totalWeight = 0;
      let valueType: string | undefined;
      let valueSize = 0;

      for (const action of activeActions) {
        const idx = action.getTrackIndex(trackName);
        if (idx < 0) continue;

        const w = action.getEffectiveWeight();
        if (w <= 0) continue;

        const val = action.getTrackValue(idx);
        valueType = action.trackValueTypes[idx];
        valueSize = action.trackValueSizes[idx];

        if (totalWeight === 0) {
          for (let i = 0; i < valueSize; i++) buffer[i] = val[i];
        } else {
          const mix = w / (totalWeight + w);
          if (valueType === 'quaternion') {
            slerpQuaternionInPlace(buffer, val, mix);
          } else {
            for (let i = 0; i < valueSize; i++) {
              buffer[i] += (val[i] - buffer[i]) * mix;
            }
          }
        }

        totalWeight += w;
      }

      if (totalWeight > 0) {
        this._activeTrackNames.add(trackName);
        // Cap at 1: above 1 means multiple actions fully cover the track,
        // which the incremental-average blending already handles correctly.
        this._sampledWeights.set(trackName, Math.min(1, totalWeight));
      }
    }
  }

  // ---------------------------------------------------------------------------
  //  Internal bindings (called by AnimationLayerMixer)
  // ---------------------------------------------------------------------------

  /** @internal */
  _bindMixer(mixer: AnimationLayerMixer): void {
    this._mixer = mixer;
  }

  // ---------------------------------------------------------------------------
  //  Private helpers
  // ---------------------------------------------------------------------------

  private _scheduleFade(duration: number, weightNow: number, weightThen: number): this {
    if (!this._mixer) throw new Error('AnimationLayer must be bound to an AnimationLayerMixer before fading.');
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

  private _updateEffectiveWeight(mixerTime: number): void {
    let w = this.weight;
    const interp = this._weightInterpolant;
    if (interp !== null) {
      const v = interp.evaluate(mixerTime)[0];
      w *= v;
      if (mixerTime > interp.parameterPositions[1]) {
        this.stopFading();
      }
    }
    this._effectiveLayerWeight = w;
  }
}

export function slerpQuaternionInPlace(
  dst: Float64Array,
  src1: ArrayLike<number>,
  t: number,
): void {
  Quaternion.slerpFlat(
    dst as unknown as number[], 0,
    dst as unknown as number[], 0,
    src1 as unknown as number[], 0,
    t,
  );
}
