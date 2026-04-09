import { LinearInterpolant, PropertyBinding, Quaternion } from 'three';
import { AnimationLayer } from './AnimationLayer.js';

const _controlInterpolantsResultBuffer = new Float32Array( 1 );

/**
 * Per-bone animation compositor with layer priority, masks, and blend modes.
 */
export class AnimationLayerMixer {

	constructor( root ) {

		this.root = root;
		this.time = 0;
		this.timeScale = 1;
		this._layers = [];
		this._trackInfos = new Map();
		this._quatWork = new Float64Array( 4 );
		this._controlInterpolants = [];
		this._nActiveControlInterpolants = 0;
		this._listeners = new Map();

	}

	get layers() {

		return this._layers;

	}

	addLayer( name, opts ) {

		const layer = new AnimationLayer(
			name,
			opts?.mask ?? null,
			opts?.blendMode ?? 'override',
		);
		layer._bindMixer( this );
		layer._setTrackCallback( ( tracks ) => this._registerTracks( tracks ) );
		this._layers.push( layer );
		return layer;

	}

	stopAllAction() {

		for ( const layer of this._layers ) {

			layer.stopAllActions();

		}

		return this;

	}

	getRoot() {

		return this.root;

	}

	setTime( timeInSeconds ) {

		const prevTimeScale = this.timeScale;
		this.timeScale = 1;
		this.update( timeInSeconds - this.time );
		this.timeScale = prevTimeScale;
		return this;

	}

	update( dt ) {

		dt *= this.timeScale;
		this.time += dt;
		const mixerTime = this.time;

		for ( const layer of this._layers ) {

			layer._sample( dt, mixerTime );

		}

		this._compose();

	}

	addEventListener( type, listener ) {

		let set = this._listeners.get( type );
		if ( ! set ) {

			set = new Set();
			this._listeners.set( type, set );

		}

		set.add( listener );

	}

	removeEventListener( type, listener ) {

		this._listeners.get( type )?.delete( listener );

	}

	_dispatchFinished( action, direction ) {

		const event = { type: 'finished', action, direction };
		this._listeners.get( 'finished' )?.forEach( ( fn ) => fn( event ) );

	}

	_dispatchLoop( action, loopDelta ) {

		const event = { type: 'loop', action, loopDelta };
		this._listeners.get( 'loop' )?.forEach( ( fn ) => fn( event ) );

	}

	_lendControlInterpolant() {

		const pool = this._controlInterpolants;
		const idx = this._nActiveControlInterpolants ++;
		let interp = pool[ idx ];
		if ( interp === undefined ) {

			interp = new LinearInterpolant(
				new Float32Array( 2 ), new Float32Array( 2 ),
				1, _controlInterpolantsResultBuffer,
			);
			interp.__cacheIndex = idx;
			pool[ idx ] = interp;

		}

		return interp;

	}

	_takeBackControlInterpolant( interp ) {

		const pool = this._controlInterpolants;
		const prevIdx = interp.__cacheIndex;
		const firstInactive = -- this._nActiveControlInterpolants;
		const last = pool[ firstInactive ];
		interp.__cacheIndex = firstInactive;
		pool[ firstInactive ] = interp;
		last.__cacheIndex = prevIdx;
		pool[ prevIdx ] = last;

	}

	_registerTracks( tracks ) {

		for ( const track of tracks ) {

			if ( this._trackInfos.has( track.name ) ) continue;

			const binding = PropertyBinding.create( this.root, track.name );
			const valueSize = track.getValueSize();
			const info = {
				name: track.name,
				binding,
				valueType: track.ValueTypeName,
				valueSize,
				originalValue: new Float64Array( valueSize ),
				composedValue: new Float64Array( valueSize ),
			};

			binding.getValue( info.originalValue, 0 );
			this._trackInfos.set( track.name, info );

		}

	}

	_compose() {

		this._trackInfos.forEach( ( info ) => {

			info.composedValue.set( info.originalValue );

			for ( const layer of this._layers ) {

				const layerWeight = layer.getEffectiveWeight();
				if ( layerWeight <= 0 ) continue;

				const layerValue = layer.getSampledValue( info.name );
				if ( ! layerValue ) continue;

				const maskWeight = layer.mask ? layer.mask.getWeight( info.name ) : 1;
				const sampledWeight = layer.getSampledWeight( info.name );
				const effectiveWeight = layerWeight * maskWeight * sampledWeight;
				if ( effectiveWeight <= 0 ) continue;

				if ( layer.blendMode === 'override' ) {

					this._blendOverride( info, layerValue, effectiveWeight );

				} else {

					this._blendAdditive( info, layerValue, effectiveWeight );

				}

			}

			info.binding.setValue( info.composedValue, 0 );

		} );

	}

	_blendOverride( info, src, weight ) {

		const dst = info.composedValue;
		if ( info.valueType === 'quaternion' ) {

			Quaternion.slerpFlat(
				dst, 0,
				dst, 0,
				src, 0,
				weight,
			);

		} else {

			for ( let i = 0; i < info.valueSize; i ++ ) {

				dst[ i ] += ( src[ i ] - dst[ i ] ) * weight;

			}

		}

	}

	_blendAdditive( info, src, weight ) {

		const dst = info.composedValue;
		if ( info.valueType === 'quaternion' ) {

			const work = this._quatWork;
			Quaternion.multiplyQuaternionsFlat(
				work, 0,
				dst, 0,
				src, 0,
			);
			Quaternion.slerpFlat(
				dst, 0,
				dst, 0,
				work, 0,
				weight,
			);

		} else {

			for ( let i = 0; i < info.valueSize; i ++ ) {

				dst[ i ] += src[ i ] * weight;

			}

		}

	}

}
