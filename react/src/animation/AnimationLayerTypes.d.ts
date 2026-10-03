import { PropertyBinding, LinearInterpolant, KeyframeTrack, Interpolant, Object3D } from 'three';

export type MutablePropertyBinding = PropertyBinding & {
	/** Resolved target object, set once the binding has been bound. */
	node: Object3D | null;
	getValue: (dst: Float64Array, index: number) => void;
	setValue: (src: Float64Array, index: number) => void;
};

export type MutableLinearInterpolant = LinearInterpolant & {
	__cacheIndex: number;
};

export type KeyframeTrackWithCreateInterpolant = KeyframeTrack & {
	createInterpolant: (resultBuffer?: TypedArray) => Interpolant;
};

export type InterpolantWithSettings = Interpolant & {
	settings: { endingStart: number; endingEnd: number };
};
