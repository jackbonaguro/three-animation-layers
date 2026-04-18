import { PropertyBinding, LinearInterpolant, KeyframeTrack, Interpolant } from 'three';

export type MutablePropertyBinding = PropertyBinding & {
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
