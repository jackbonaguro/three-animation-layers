import { LinearInterpolant, Object3D, PropertyBinding, Quaternion } from 'three';
import { AnimationLayer, LayerBlendMode } from './AnimationLayer';
import { AnimationLayerMask } from './AnimationLayerMask';

const _controlInterpolantsResultBuffer = new Float32Array(1);

export interface LayerOptions {
  mask?: AnimationLayerMask | null;
  blendMode?: LayerBlendMode;
}

/**
 * Cached information for a single animated track (e.g. one bone's quaternion).
 * Created once when a clip first introduces the track, reused every frame.
 */
interface TrackInfo {
  name: string;
  /** PropertyBinding with runtime-bound getValue / setValue (untyped). */
  binding: any;
  valueType: string;
  valueSize: number;
  /** Rest / bind-pose value captured at registration time. */
  originalValue: Float64Array;
  /** Scratch buffer for composing the final value across layers each frame. */
  composedValue: Float64Array;
}

/**
 * Per-bone animation compositor.
 *
 * Replaces Three's {@link AnimationMixer} with a layer-based model where
 * each layer independently samples its clips and the mixer composes the
 * results per bone, respecting layer priority, masks, and blend mode.
 *
 * Layers are evaluated bottom-to-top (first added = lowest priority).
 *
 * ```
 * const mixer = new LayeredMixer(rig);
 * const base  = mixer.addLayer('base');
 * const upper = mixer.addLayer('upper', { mask });
 *
 * base.play(clipA);
 * upper.play(clipB).fadeIn(0.3);
 *
 * // each frame
 * mixer.update(dt);
 * ```
 */
export class LayeredMixer {
  readonly root: Object3D;
  time = 0;
  timeScale = 1;

  private _layers: AnimationLayer[] = [];
  private _trackInfos = new Map<string, TrackInfo>();
  /** Scratch buffer for additive quaternion blending. */
  private _quatWork = new Float64Array(4);

  /** Pooled weight-fade interpolants; same pattern as Three's AnimationMixer. */
  private _controlInterpolants: LinearInterpolant[] = [];
  private _nActiveControlInterpolants = 0;

  constructor(root: Object3D) {
    this.root = root;
  }

  get layers(): readonly AnimationLayer[] {
    return this._layers;
  }

  addLayer(name: string, opts?: LayerOptions): AnimationLayer {
    const layer = new AnimationLayer(
      name,
      opts?.mask ?? null,
      opts?.blendMode ?? 'override',
    );

    layer._bindMixer(this);
    layer._setTrackCallback((tracks) => this._registerTracks(tracks));
    this._layers.push(layer);
    return layer;
  }

  /**
   * @internal Used by {@link LayerAction} for weight-fade curves.
   * Mirrors Three's AnimationMixer._lendControlInterpolant.
   */
  _lendControlInterpolant(): LinearInterpolant {
    const pool = this._controlInterpolants;
    const idx = this._nActiveControlInterpolants++;
    let interp = pool[idx];
    if (interp === undefined) {
      interp = new LinearInterpolant(
        new Float32Array(2), new Float32Array(2),
        1, _controlInterpolantsResultBuffer,
      );
      (interp as any).__cacheIndex = idx;
      pool[idx] = interp;
    }
    return interp;
  }

  /** @internal */
  _takeBackControlInterpolant(interp: LinearInterpolant): void {
    const pool = this._controlInterpolants;
    const prevIdx = (interp as any).__cacheIndex;
    const firstInactive = --this._nActiveControlInterpolants;
    const last = pool[firstInactive];
    (interp as any).__cacheIndex = firstInactive;
    pool[firstInactive] = interp;
    (last as any).__cacheIndex = prevIdx;
    pool[prevIdx] = last;
  }

  /**
   * Advance every layer by `dt` (scaled by {@link timeScale}) and write the
   * composed result to the scene graph.
   */
  update(dt: number): void {
    dt *= this.timeScale;
    this.time += dt;
    const mixerTime = this.time;

    for (const layer of this._layers) {
      layer._sample(dt, mixerTime);
    }

    this._compose();
  }

  // ---------------------------------------------------------------------------
  //  Track registration
  // ---------------------------------------------------------------------------

  private _registerTracks(
    tracks: readonly { name: string; ValueTypeName: string; getValueSize(): number }[],
  ): void {
    for (const track of tracks) {
      if (this._trackInfos.has(track.name)) continue;

      const binding = PropertyBinding.create(this.root, track.name);
      const valueSize = track.getValueSize();
      const info: TrackInfo = {
        name: track.name,
        binding,
        valueType: track.ValueTypeName,
        valueSize,
        originalValue: new Float64Array(valueSize),
        composedValue: new Float64Array(valueSize),
      };

      // Capture the bone's current transform as the rest-pose fallback.
      // The first getValue call triggers PropertyBinding.bind() internally.
      (binding as any).getValue(info.originalValue, 0);

      this._trackInfos.set(track.name, info);
    }
  }

  // ---------------------------------------------------------------------------
  //  Cross-layer composition
  // ---------------------------------------------------------------------------

  private _compose(): void {
    this._trackInfos.forEach((info) => {
      // Start from the rest / bind-pose value.
      info.composedValue.set(info.originalValue);

      for (const layer of this._layers) {
        if (layer.weight <= 0) continue;

        const layerValue = layer.getSampledValue(info.name);
        if (!layerValue) continue;

        const maskWeight = layer.mask ? layer.mask.getWeight(info.name) : 1;
        // sampledWeight carries action-level fading (e.g. fadeIn/fadeOut) into
        // the cross-layer composition, completing the data flow.
        const sampledWeight = layer.getSampledWeight(info.name);
        const effectiveWeight = layer.weight * maskWeight * sampledWeight;
        if (effectiveWeight <= 0) continue;

        if (layer.blendMode === 'override') {
          this._blendOverride(info, layerValue, effectiveWeight);
        } else {
          this._blendAdditive(info, layerValue, effectiveWeight);
        }
      }

      // Write the final composed value to the scene graph.
      (info.binding as any).setValue(info.composedValue, 0);
    });
  }

  private _blendOverride(info: TrackInfo, src: Float64Array, weight: number): void {
    const dst = info.composedValue;
    if (info.valueType === 'quaternion') {
      Quaternion.slerpFlat(
        dst as unknown as number[], 0,
        dst as unknown as number[], 0,
        src as unknown as number[], 0,
        weight,
      );
    } else {
      for (let i = 0; i < info.valueSize; i++) {
        dst[i] += (src[i] - dst[i]) * weight;
      }
    }
  }

  private _blendAdditive(info: TrackInfo, src: Float64Array, weight: number): void {
    const dst = info.composedValue;
    if (info.valueType === 'quaternion') {
      const work = this._quatWork;
      Quaternion.multiplyQuaternionsFlat(
        work as unknown as number[], 0,
        dst as unknown as number[], 0,
        src as unknown as number[], 0,
      );
      Quaternion.slerpFlat(
        dst as unknown as number[], 0,
        dst as unknown as number[], 0,
        work as unknown as number[], 0,
        weight,
      );
    } else {
      for (let i = 0; i < info.valueSize; i++) {
        dst[i] += src[i] * weight;
      }
    }
  }
}
