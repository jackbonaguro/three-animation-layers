import * as THREE from 'three';

/**
 * Scalar value that exponentially eases toward a target.
 *
 * Wraps {@link THREE.MathUtils.damp} so call sites read as
 * `value.target = …; value.update(dt)` instead of repeating the
 * `lerp(x, y, 1 - exp(-λ·dt))` boilerplate.
 *
 * `smoothingTau` is the time constant in seconds: roughly 63% of the gap
 * to {@link target} closes per τ; smaller = snappier. `0` disables
 * smoothing entirely (each `update` snaps to {@link target}).
 */
export class DampedValue {
  /** Time constant (seconds). ~63% of the gap closes per τ. 0 = no smoothing (snap). */
  smoothingTau: number;

  private _value: number;
  private _target: number;

  constructor(initial: number, smoothingTau: number) {
    this._value = initial;
    this._target = initial;
    this.smoothingTau = smoothingTau;
  }

  /** Current eased value. */
  get value(): number {
    return this._value;
  }

  /** Value the eased {@link value} is moving toward. */
  get target(): number {
    return this._target;
  }
  set target(t: number) {
    this._target = t;
  }

  /** Advance toward {@link target} by `deltaSeconds`. Returns the new {@link value}. */
  update(deltaSeconds: number): number {
    if (this.smoothingTau <= 0 || deltaSeconds <= 0) {
      this._value = this._target;
    } else {
      this._value = THREE.MathUtils.damp(
        this._value,
        this._target,
        1 / this.smoothingTau,
        deltaSeconds,
      );
    }
    return this._value;
  }

  /** Force both the current and target values to `value`, cancelling any in-flight ease. */
  snap(value: number): void {
    this._value = value;
    this._target = value;
  }
}
