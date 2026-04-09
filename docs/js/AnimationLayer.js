import { Quaternion } from 'three';
import { AnimationLayerAction } from './AnimationLayerAction.js';

function slerpFlat64( dst, dstOff, src0, src0Off, src1, src1Off, t ) {

	Quaternion.slerpFlat(
		dst,
		dstOff,
		src0,
		src0Off,
		src1,
		src1Off,
		t,
	);

}

/**
 * A single priority level within an AnimationLayerMixer.
 */
export class AnimationLayer {

	constructor( name, mask = null, blendMode = 'override' ) {

		this.name = name;
		this.mask = mask;
		this.blendMode = blendMode;

		this.weight = 1;
		this._actions = [];
		this._sampledValues = new Map();
		this._sampledValueTypes = new Map();
		this._activeTrackNames = new Set();
		this._sampledWeights = new Map();
		this._onTracksDiscovered = null;
		this._mixer = null;
		this._weightInterpolant = null;
		this._effectiveLayerWeight = 1;

	}

	get actions() {

		return this._actions;

	}

	getEffectiveWeight() {

		return this._effectiveLayerWeight;

	}

	setEffectiveWeight( w ) {

		this.weight = w;
		this._effectiveLayerWeight = w;
		return this.stopFading();

	}

	fadeIn( duration ) {

		return this._scheduleFade( duration, 0, 1 );

	}

	fadeOut( duration ) {

		return this._scheduleFade( duration, 1, 0 );

	}

	stopFading() {

		if ( this._weightInterpolant !== null ) {

			this._mixer._takeBackControlInterpolant( this._weightInterpolant );
			this._weightInterpolant = null;

		}

		return this;

	}

	play( clip ) {

		if ( ! this._mixer ) throw new Error( 'AnimationLayer must be added via AnimationLayerMixer.addLayer before calling play()' );
		const action = new AnimationLayerAction( clip, this._mixer );
		action._isScheduled = true;
		this._actions.push( action );

		for ( const track of clip.tracks ) {

			if ( ! this._sampledValues.has( track.name ) ) {

				this._sampledValues.set( track.name, new Float64Array( track.getValueSize() ) );
				this._sampledValueTypes.set( track.name, track.ValueTypeName );

			}

		}

		if ( this._onTracksDiscovered ) this._onTracksDiscovered( clip.tracks );

		action.play();
		return action;

	}

	getAction( clip ) {

		return this._actions.find( ( a ) => a.clip === clip ) ?? null;

	}

	removeAction( action ) {

		const idx = this._actions.indexOf( action );
		if ( idx >= 0 ) {

			action._isScheduled = false;
			this._actions.splice( idx, 1 );

		}

	}

	stopAllActions() {

		for ( const action of this._actions ) {

			action.stop();

		}

		return this;

	}

	getSampledValue( trackName ) {

		if ( ! this._activeTrackNames.has( trackName ) ) return null;
		return this._sampledValues.get( trackName ) ?? null;

	}

	getSampledValueType( trackName ) {

		return this._sampledValueTypes.get( trackName );

	}

	getSampledWeight( trackName ) {

		return this._sampledWeights.get( trackName ) ?? 0;

	}

	_sample( dt, mixerTime ) {

		this._updateEffectiveWeight( mixerTime );

		this._activeTrackNames.clear();
		this._sampledWeights.clear();

		const activeActions = [];
		for ( const action of this._actions ) {

			action._advance( dt, mixerTime );
			if ( action.enabled && action.getEffectiveWeight() > 0 ) {

				activeActions.push( action );

			}

		}

		if ( activeActions.length === 0 ) return;

		const trackSet = new Set();
		for ( const action of activeActions ) {

			for ( const name of action.trackNames ) {

				trackSet.add( name );

			}

		}

		const trackNames = Array.from( trackSet );
		for ( const trackName of trackNames ) {

			const buffer = this._sampledValues.get( trackName );
			if ( ! buffer ) continue;

			let totalWeight = 0;
			let valueType;
			let valueSize = 0;

			for ( const action of activeActions ) {

				const idx = action.getTrackIndex( trackName );
				if ( idx < 0 ) continue;

				const w = action.getEffectiveWeight();
				if ( w <= 0 ) continue;

				const val = action.getTrackValue( idx );
				valueType = action.trackValueTypes[ idx ];
				valueSize = action.trackValueSizes[ idx ];

				if ( totalWeight === 0 ) {

					for ( let i = 0; i < valueSize; i ++ ) buffer[ i ] = val[ i ];

				} else {

					const mix = w / ( totalWeight + w );
					if ( valueType === 'quaternion' ) {

						slerpFlat64( buffer, 0, buffer, 0, val, 0, mix );

					} else {

						for ( let i = 0; i < valueSize; i ++ ) {

							buffer[ i ] += ( val[ i ] - buffer[ i ] ) * mix;

						}

					}

				}

				totalWeight += w;

			}

			if ( totalWeight > 0 ) {

				this._activeTrackNames.add( trackName );
				this._sampledWeights.set( trackName, Math.min( 1, totalWeight ) );

			}

		}

	}

	_bindMixer( mixer ) {

		this._mixer = mixer;

	}

	_setTrackCallback( cb ) {

		this._onTracksDiscovered = cb;

	}

	_scheduleFade( duration, weightNow, weightThen ) {

		if ( ! this._mixer ) throw new Error( 'AnimationLayer must be bound to an AnimationLayerMixer before fading.' );
		const now = this._mixer.time;
		let interp = this._weightInterpolant;
		if ( interp === null ) {

			interp = this._mixer._lendControlInterpolant();
			this._weightInterpolant = interp;

		}

		interp.parameterPositions[ 0 ] = now;
		interp.parameterPositions[ 1 ] = now + duration;
		interp.sampleValues[ 0 ] = weightNow;
		interp.sampleValues[ 1 ] = weightThen;
		return this;

	}

	_updateEffectiveWeight( mixerTime ) {

		let w = this.weight;
		const interp = this._weightInterpolant;
		if ( interp !== null ) {

			const v = interp.evaluate( mixerTime )[ 0 ];
			w *= v;
			if ( mixerTime > interp.parameterPositions[ 1 ] ) {

				this.stopFading();

			}

		}

		this._effectiveLayerWeight = w;

	}

}
