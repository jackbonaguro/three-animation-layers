import { KeyframeTrack, LinearInterpolant, Object3D, PropertyBinding, Quaternion } from 'three';
import { AnimationLayer, LayerBlendMode, LayerBlendSpace, slerpQuaternionInPlace } from './AnimationLayer';
import { AnimationLayerMask } from './AnimationLayerMask';
import type { MutablePropertyBinding, MutableLinearInterpolant } from './AnimationLayerTypes';

/** Scratch buffers, reused to prevent huge # of allocations that need to be continuously GC'd. */
// needed by the signature of LinearInterpolant; we then throw the result away
const _controlInterpolantsResultBuffer = new Float32Array(1);
// dst for additive quaternion blending, gets continuously overwritten
const _quatWork = new Float64Array(4);
// chain of objects traversed by _getMeshSpaceQuaternion up to the root
const _chain: Object3D[] = [];
// set of quaternions used in _blendMeshSpace
const _qParentFlat = new Float64Array(4);
const _qSourceFlat = new Float64Array(4);
const _qTargetFlat = new Float64Array(4);

export interface LayerOptions {
  mask?: AnimationLayerMask | null;
  blendMode?: LayerBlendMode;
  blendSpace?: LayerBlendSpace;
}

// ---------------------------------------------------------------------------
//  Internal track cache
// ---------------------------------------------------------------------------

/**
 * Cached information for a single animated track (e.g. one bone's quaternion).
 * Created once when a clip first introduces the track, reused every frame.
 */
interface TrackInfo {
  name: string;
  /** PropertyBinding with runtime-bound getValue / setValue (untyped). */
  binding: MutablePropertyBinding;
  /** Object the track drives (null if the binding failed to resolve). */
  node: Object3D | null;
  /** Number of ancestors between `node` and the mixer root; parents compose before children. */
  depth: number;
  valueType: string;
  valueSize: number;
  /** Rest / bind-pose value captured at registration time. */
  originalValue: Float64Array;
  /** Scratch buffer for composing the final value across layers each frame. */
  composedValue: Float64Array;
}

/**
 * Animation Mixer with support for independent per-bone weights per action.
 * These weights can be combined by layers, which supply bone weights via a mask.
 *
 * Each layer independently samples its clips, and the mixer composes the
 * results respecting layer priority, masks, and blend mode.
 *
 * Layers are evaluated bottom-to-top (first added = lowest priority).
 * 
 * Also unlike the stock animation system, most of the actual logic for blending
 * is here, not in the actions or PropertyMixer classes.
 */
export class AnimationLayerMixer {
  readonly root: Object3D;
  time = 0;
  timeScale = 1;

  private _layers: AnimationLayer[] = [];
  private _trackInfos = new Map<string, TrackInfo>();

  /** Same infos sorted by depth so ancestors are composed (and written) first. */
  private _orderedTrackInfos: TrackInfo[] = [];
  /** Quaternion track per animated object, for walking ancestor chains in mesh space. */
  private _quaternionTrackByNode = new Map<Object3D, TrackInfo>();

  /** Pooled weight-fade interpolants; same pattern as Three's AnimationMixer. */
  private _controlInterpolants: MutableLinearInterpolant[] = [];
  private _nActiveControlInterpolants = 0;

  constructor(root: Object3D) {
    this.root = root;
  }

  get layers(): readonly AnimationLayer[] {
    return this._layers;
  }

  // ---------------------------------------------------------------------------
  //  Layer management
  // ---------------------------------------------------------------------------

  addLayer(name: string, opts?: LayerOptions): AnimationLayer {
    const layer = new AnimationLayer(
      name,
      opts?.mask ?? null,
      opts?.blendMode,
      opts?.blendSpace,
    );

    layer._bindMixer(this);
    this._layers.push(layer);
    return layer;
  }

  // ---------------------------------------------------------------------------
  //  Playback control
  // ---------------------------------------------------------------------------

  /**
   * Stops all actions across every layer.
   */
  stopAllAction(): this {
    for (const layer of this._layers) {
      layer.stopAllActions();
    }
    return this;
  }

  /**
   * Returns the root object passed to the constructor.
   * Mirrors Three's `AnimationMixer.getRoot()`.
   */
  getRoot(): Object3D {
    return this.root;
  }

  /**
   * Seeks the mixer to an absolute time, advancing (or rewinding) all layers
   * by the necessary delta.  {@link timeScale} is temporarily bypassed so the
   * target time is always reached exactly.
   */
  setTime(timeInSeconds: number): this {
    const prevTimeScale = this.timeScale;
    this.timeScale = 1;
    this.update(timeInSeconds - this.time);
    this.timeScale = prevTimeScale;
    return this;
  }

  // ---------------------------------------------------------------------------
  //  Main update
  // ---------------------------------------------------------------------------

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
  //  Control interpolant pool (shared with AnimationLayerAction and AnimationLayer)
  // ---------------------------------------------------------------------------

  /**
   * @internal Used by {@link AnimationLayerAction} and {@link AnimationLayer} for weight/time-scale fade curves.
   * Mirrors Three's AnimationMixer._lendControlInterpolant.
   */
  _lendControlInterpolant(): MutableLinearInterpolant {
    const pool = this._controlInterpolants;
    const idx = this._nActiveControlInterpolants++;
    let interp = pool[idx];
    if (interp === undefined) {
      interp = new LinearInterpolant(
        new Float32Array(2), new Float32Array(2),
        1, _controlInterpolantsResultBuffer,
      ) as MutableLinearInterpolant;
      interp.__cacheIndex = idx;
      pool[idx] = interp;
    }
    return interp;
  }

  /** @internal */
  _takeBackControlInterpolant(interp: MutableLinearInterpolant): void {
    const pool = this._controlInterpolants;
    const prevIdx = interp.__cacheIndex;
    const firstInactive = --this._nActiveControlInterpolants;
    const last = pool[firstInactive];
    interp.__cacheIndex = firstInactive;
    pool[firstInactive] = interp;
    last.__cacheIndex = prevIdx;
    pool[prevIdx] = last;
  }

  // ---------------------------------------------------------------------------
  //  Track registration
  // ---------------------------------------------------------------------------

  registerTracks(
    tracks: KeyframeTrack[]
  ): void {
    for (const track of tracks) {
      if (this._trackInfos.has(track.name)) continue;

      const binding = PropertyBinding.create(this.root, track.name) as MutablePropertyBinding;
      const valueSize = track.getValueSize();
      const info: TrackInfo = {
        name: track.name,
        binding,
        node: null,
        depth: 0,
        valueType: track.ValueTypeName,
        valueSize,
        originalValue: new Float64Array(valueSize),
        composedValue: new Float64Array(valueSize),
      };

      // Capture the bone's current transform as the rest-pose fallback.
      // The first getValue call triggers PropertyBinding.bind() internally.
      binding.getValue(info.originalValue, 0);

      info.node = binding.node;
      for (let n = info.node; n && n !== this.root; n = n.parent) info.depth++;
      if (info.node && info.valueType === 'quaternion') {
        this._quaternionTrackByNode.set(info.node, info);
      }

      this._trackInfos.set(track.name, info);
      this._orderedTrackInfos.push(info);
    }
    this._orderedTrackInfos.sort((a, b) => a.depth - b.depth);
  }

  // ---------------------------------------------------------------------------
  //  Cross-layer composition
  // ---------------------------------------------------------------------------

  private _compose(): void {
    // Depth order: a mesh-space blend reads its ancestors' already-written rotations.
    for (const info of this._orderedTrackInfos) {
      // Start from the rest / bind-pose value.
      info.composedValue.set(info.originalValue);

      for (const layer of this._layers) {
        // Use getEffectiveWeight so layer-level fades are respected.
        const layerWeight = layer.getEffectiveWeight();
        if (layerWeight <= 0) continue;

        const layerValue = layer.getSampledValue(info.name);
        if (!layerValue) continue;

        const maskWeight = layer.mask ? layer.mask.getWeight(info.name) : 1;
        // sampledWeight carries action-level fading (e.g. fadeIn/fadeOut) into
        // the cross-layer composition, completing the data flow.
        const sampledWeight = layer.getSampledWeight(info.name);
        const effectiveWeight = layerWeight * maskWeight * sampledWeight;
        if (effectiveWeight <= 0) continue;

        if (layer.blendSpace === 'mesh') {
          // unlike local blends, mesh-space blend will need the whole layer's data
          this._blendMeshSpace(info, layer, layer.blendMode, effectiveWeight);
        } else {
          if (layer.blendMode === 'additive') {
            this._blendAdditive(info, layerValue, effectiveWeight);
          } else {
            this._blendOverride(info, layerValue, effectiveWeight);
          }
        }
      }

      // Write the final composed value to the scene graph.
      info.binding.setValue(info.composedValue, 0);
    }
  }

  private _blendQuaternionFlatAdditive(dst: Float64Array, src: Float64Array, weight: number): void {
    Quaternion.multiplyQuaternionsFlat(
      _quatWork as unknown as number[], 0,
      dst as unknown as number[], 0,
      src as unknown as number[], 0,
    );
    slerpQuaternionInPlace(dst, _quatWork, weight);
  }

  private _blendQuaternionFlatOverride(dst: Float64Array, src: Float64Array, weight: number): void {
    slerpQuaternionInPlace(dst, src, weight);
  }

  private _blendLinearAdditive(dst: Float64Array, src: Float64Array, size: number, weight: number): void {
    for (let i = 0; i < size; i++) {
      dst[i] += src[i] * weight;
    }
  }

  private _blendLinearOverride(dst: Float64Array, src: Float64Array, size: number, weight: number): void {
    for (let i = 0; i < size; i++) {
      dst[i] += (src[i] - dst[i]) * weight;
    }
  }

  private _blendOverride(info: TrackInfo, src: Float64Array, weight: number): void {
    const dst = info.composedValue;
    if (info.valueType === 'quaternion') {
      this._blendQuaternionFlatOverride(dst, src, weight);
    } else {
      this._blendLinearOverride(dst, src, info.valueSize, weight);
    }
  }

  private _blendAdditive(info: TrackInfo, src: Float64Array, weight: number): void {
    const dst = info.composedValue;
    if (info.valueType === 'quaternion') {
      this._blendQuaternionFlatAdditive(dst, src, weight);
    } else {
      this._blendLinearAdditive(dst, src, info.valueSize, weight);
    }
  }

  /**
   * Blend the bone's mesh-space (root-relative) rotation toward the mesh-space
   * rotation the layer's clip alone would give it, then convert back to local.
   * Ancestors have already been composed and written this frame, so their
   * scene-graph quaternions are usable for the "composed" parent chain.
   *
   * NOTE: Sorry about the readability; this is optimized using flat arrays and in-place operations.
   */
  private _blendMeshSpace(info: TrackInfo, layer: AnimationLayer, blendMode: LayerBlendMode, weight: number): void {
    const dst = info.composedValue;

    if (info.valueType === 'quaternion') {
      const node = info.node!;

      // Since the data on the skeleton itself is in local space, first convert the current composed value to mesh space.
      // Start by getting the parent's mesh space quaternion.
      this._getMeshSpaceQuaternionFlat(
        node.parent,
        this._composedLocalFlat, // will accumulate transforms from the skeleton itself
        _qParentFlat
      );

      // Then multiply it by the current local quaternion to get the mesh space quaternion.
      // NOTE: This would be unnecessary as a separate step if we didn't also need the parent quaternion for later.
      Quaternion.multiplyQuaternionsFlat(
        _qSourceFlat as unknown as number[], 0,
        _qParentFlat as unknown as number[], 0,
        dst as unknown as number[], 0,
      );

      // Compute the target value in its own layer's mesh space, ignoring the effects of other layers.
      this._getMeshSpaceQuaternionFlat(
        node,
        // Will accumulate transforms from the animation layer only.
        // This is precisely what allows this layer to appear exactly as authored,
        // by not even involving the effects of other layers.
        (n) => this._layerLocalFlat(layer, n),
        _qTargetFlat
      );

      // Finally interpolate the two values!
      if (blendMode === 'override') {
        this._blendQuaternionFlatOverride(_qSourceFlat, _qTargetFlat, weight);
      } else {
        this._blendQuaternionFlatAdditive(_qSourceFlat, _qTargetFlat, weight);
      }

      // Compute the difference between the original and target mesh space quaternions.
      // Since the difference between parent mesh and local space applies to both, it factors out and
      // the difference can be applied directly to the local quaternion.
      Quaternion.multiplyQuaternionsFlat(
        dst as unknown as number[], 0,
        [
          -_qParentFlat[0],
          -_qParentFlat[1],
          -_qParentFlat[2],
          _qParentFlat[3],
        ], 0,
        _qSourceFlat as unknown as number[], 0,
      );
    }
  }

  /** Rotation of `node` relative to the mixer root, accumulating `local(n)` from the root down. */
  private _getMeshSpaceQuaternionFlat(
    node: Object3D | null,
    local: (n: Object3D) => Float64Array,
    out: Float64Array,
  ): Float64Array {
    _chain.length = 0;
    for (let n = node; n && n !== this.root; n = n.parent) _chain.push(n);

    out.set([0, 0, 0, 1]);
    for (let i = _chain.length - 1; i >= 0; i--) {
      Quaternion.multiplyQuaternionsFlat(
        out as unknown as number[], 0,
        out as unknown as number[], 0,
        local(_chain[i]) as unknown as number[], 0,
      );
    }
    return out;
  }

  // local transform on the actual skeleton itself, including mesh-space blends already applied
  private _composedLocalFlat = (n: Object3D): Float64Array => new Float64Array(n.quaternion.toArray());

  // local transform from the layer, never converted to mesh space
  private _layerLocalFlat(layer: AnimationLayer, n: Object3D): Float64Array {
    const info = this._quaternionTrackByNode.get(n);
    if (!info) return new Float64Array(n.quaternion.toArray());
    return layer.getSampledValue(info.name) ?? info.originalValue;
  }
}
