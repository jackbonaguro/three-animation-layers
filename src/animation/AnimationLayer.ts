import { AnimationClip, Quaternion } from 'three';
import { AnimationLayerMask } from './AnimationLayerMask';
import { LayerAction } from './LayerAction';

export type LayerBlendMode = 'override' | 'additive';

type TrackDiscoveryCallback = (
  tracks: readonly { name: string; ValueTypeName: string; getValueSize(): number }[],
) => void;

/**
 * A single priority level within a {@link LayeredMixer}.
 *
 * Each layer holds one or more {@link LayerAction}s. During a mixer update
 * the layer advances all active actions, blends their per-track contributions
 * together (weighted by action weight), and exposes the result so the mixer
 * can compose across layers.
 */
export class AnimationLayer {
  readonly name: string;

  /** Global influence of this layer (0 = inactive, 1 = full). */
  weight = 1;

  /**
   * Per-bone weight mask.  Bones not listed default to 0 (no influence).
   * Pass `null` for a full-body layer (every bone weight = 1).
   */
  mask: AnimationLayerMask | null;

  blendMode: LayerBlendMode;

  private _actions: LayerAction[] = [];

  // Per-track blended value buffers, keyed by track name.  Re-used across frames.
  private _sampledValues = new Map<string, Float64Array>();
  private _sampledValueTypes = new Map<string, string>();
  private _activeTrackNames = new Set<string>();

  private _onTracksDiscovered: TrackDiscoveryCallback | null = null;

  constructor(
    name: string,
    mask: AnimationLayerMask | null = null,
    blendMode: LayerBlendMode = 'override',
  ) {
    this.name = name;
    this.mask = mask;
    this.blendMode = blendMode;
  }

  get actions(): readonly LayerAction[] {
    return this._actions;
  }

  /**
   * Create a {@link LayerAction} for `clip`, add it to this layer, and
   * start playback.  Returns the action so callers can configure loop mode,
   * weight, etc.
   */
  play(clip: AnimationClip): LayerAction {
    const action = new LayerAction(clip);
    this._actions.push(action);

    for (const track of clip.tracks) {
      if (!this._sampledValues.has(track.name)) {
        this._sampledValues.set(track.name, new Float64Array(track.getValueSize()));
        this._sampledValueTypes.set(track.name, track.ValueTypeName);
      }
    }

    this._onTracksDiscovered?.(clip.tracks);

    action.play();
    return action;
  }

  removeAction(action: LayerAction): void {
    const idx = this._actions.indexOf(action);
    if (idx >= 0) this._actions.splice(idx, 1);
  }

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
   * Advance all actions by `dt` and blend their per-track contributions
   * into the layer's sample buffers.
   *
   * @internal Called by the owning {@link LayeredMixer}.
   */
  _sample(dt: number): void {
    this._activeTrackNames.clear();

    // Advance every action.  Collect those that are active and weighted.
    const activeActions: LayerAction[] = [];
    for (const action of this._actions) {
      if (!action.enabled || action.paused) continue;
      action._advance(dt);
      // _advance may disable the action (e.g. LoopOnce finished)
      if (action.enabled && action.weight > 0) {
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

        const w = action.weight;
        if (w <= 0) continue;

        const val = action.getTrackValue(idx);
        valueType = action.trackValueTypes[idx];
        valueSize = action.trackValueSizes[idx];

        if (totalWeight === 0) {
          for (let i = 0; i < valueSize; i++) buffer[i] = val[i];
        } else {
          const mix = w / (totalWeight + w);
          if (valueType === 'quaternion') {
            slerpFlat64(buffer, 0, buffer, 0, val, 0, mix);
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
      }
    }
  }

  /** @internal — called by the mixer to receive track-discovery notifications. */
  _setTrackCallback(cb: TrackDiscoveryCallback): void {
    this._onTracksDiscovered = cb;
  }
}

/** Slerp helper that accepts Float64Array / ArrayLike without TS complaints. */
function slerpFlat64(
  dst: Float64Array,
  dstOff: number,
  src0: ArrayLike<number>,
  src0Off: number,
  src1: ArrayLike<number>,
  src1Off: number,
  t: number,
): void {
  Quaternion.slerpFlat(
    dst as unknown as number[],
    dstOff,
    src0 as unknown as number[],
    src0Off,
    src1 as unknown as number[],
    src1Off,
    t,
  );
}
