/**
 * Per-bone weight mask for animation layers.
 * Weights are keyed by track name (e.g. `"mixamorigSpine.quaternion"`).
 * Bones not listed default to weight 0.
 */
export class AnimationLayerMask {
	constructor( weights = {} ) {

		this._weights = new Map( Object.entries( weights ) );

	}

	getWeight( trackName ) {

		return this._weights.get( trackName ) ?? 0;

	}

	setWeight( trackName, weight ) {

		this._weights.set( trackName, Math.max( 0, Math.min( 1, weight ) ) );

	}

	setWeights( weights ) {

		for ( const [ name, w ] of Object.entries( weights ) ) {

			this.setWeight( name, w );

		}

	}

	getWeights() {

		return Object.fromEntries( this._weights );

	}

	entries() {

		return this._weights.entries();

	}

	[ Symbol.iterator ]() {

		return this._weights.entries();

	}

}
