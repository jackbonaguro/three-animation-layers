/**
 * Per-bone weight mask for animation layers.
 *
 * Weights are keyed by track name (e.g. `"mixamorigSpine.quaternion"`).
 * Bones not listed default to weight 0 (no influence from this layer).
 */
export class AnimationLayerMask {
  private _weights: Map<string, number>;

  constructor(weights: Record<string, number> = {}) {
    this._weights = new Map(Object.entries(weights));
  }

  getWeight(trackName: string): number {
    return this._weights.get(trackName) ?? 0;
  }

  setWeight(trackName: string, weight: number): void {
    this._weights.set(trackName, Math.max(0, Math.min(1, weight)));
  }

  setWeights(weights: Record<string, number>): void {
    for (const [name, w] of Object.entries(weights)) {
      this.setWeight(name, w);
    }
  }
}
