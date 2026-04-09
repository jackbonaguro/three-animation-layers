import { LoopRepeat, LoopPingPong } from 'three';

const WRAP_AROUND = 2402;
const ZERO_CURVATURE = 2400;

/**
 * Playback controller for a single clip within an AnimationLayer.
 */
export class AnimationLayerAction {

	constructor( clip, mixer ) {

		this.clip = clip;
		this._mixer = mixer;
		const tracks = clip.tracks;

		this.trackNames = tracks.map( ( t ) => t.name );
		this.trackValueTypes = tracks.map( ( t ) => t.ValueTypeName );
		this.trackValueSizes = tracks.map( ( t ) => t.getValueSize() );

		this.time = 0;
		this.timeScale = 1;
		this.weight = 1;
		this.enabled = true;
		this.paused = false;
		this.loop = LoopRepeat;
		this.repetitions = Infinity;
		this.clampWhenFinished = false;

		this._trackIndexMap = new Map();
		for ( let i = 0; i < tracks.length; i ++ ) {

			this._trackIndexMap.set( tracks[ i ].name, i );

		}

		this._interpolantSettings = {
			endingStart: WRAP_AROUND,
			endingEnd: WRAP_AROUND,
		};

		this._interpolants = tracks.map( ( t ) => {

			const interp = t.createInterpolant( undefined );
			interp.settings = this._interpolantSettings;
			return interp;

		} );

		this._weightInterpolant = null;
		this._timeScaleInterpolant = null;
		this._effectiveWeight = this.enabled ? this.weight : 0;

		this._loopCount = 0;
		this._startTime = null;
		this._syncTarget = null;
		this._isScheduled = false;

	}

	getMixer() {

		return this._mixer;

	}

	getRoot() {

		return this._mixer.root;

	}

	getEffectiveWeight() {

		return this._effectiveWeight;

	}

	setEffectiveWeight( w ) {

		this.weight = w;
		this._effectiveWeight = this.enabled ? w : 0;
		return this.stopFading();

	}

	getEffectiveTimeScale() {

		if ( this.paused ) return 0;
		return this._computeEffectiveTimeScale( this._mixer.time );

	}

	setEffectiveTimeScale( timeScale ) {

		this.timeScale = timeScale;
		return this.stopWarping();

	}

	setDuration( duration ) {

		this.timeScale = this.clip.duration / duration;
		return this.stopWarping();

	}

	syncEffectiveWeight( mixerTime ) {

		this._updateWeight( mixerTime );

	}

	isRunning() {

		return (
			this.enabled &&
			! this.paused &&
			this.timeScale !== 0 &&
			this._startTime === null
		);

	}

	isScheduled() {

		return this._isScheduled;

	}

	play() {

		this.enabled = true;
		this.paused = false;
		return this;

	}

	pause() {

		this.paused = true;
		return this;

	}

	stop() {

		this.enabled = false;
		this.time = 0;
		this._loopCount = 0;
		this._effectiveWeight = 0;
		this._startTime = null;
		this._syncTarget = null;
		return this.stopFading().stopWarping();

	}

	reset() {

		this.time = 0;
		this.paused = false;
		this.enabled = true;
		this._loopCount = 0;
		this._startTime = null;
		return this.stopFading();

	}

	startAt( mixerTime ) {

		this._startTime = mixerTime;
		return this;

	}

	setLoop( mode, repetitions ) {

		this.loop = mode;
		this.repetitions = repetitions;
		return this;

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

	warp( startTimeScale, endTimeScale, duration ) {

		return this._scheduleTimeScale( duration, startTimeScale, endTimeScale );

	}

	stopWarping() {

		if ( this._timeScaleInterpolant !== null ) {

			this._mixer._takeBackControlInterpolant( this._timeScaleInterpolant );
			this._timeScaleInterpolant = null;

		}

		return this;

	}

	halt( duration ) {

		return this._scheduleTimeScale( duration, this.getEffectiveTimeScale(), 0 );

	}

	syncWith( action ) {

		this._syncTarget = action;
		return this;

	}

	crossFadeFrom( fadeOutAction, duration, warp = false ) {

		fadeOutAction.fadeOut( duration );
		this.fadeIn( duration );

		if ( warp ) {

			const fromDuration = fadeOutAction.clip.duration;
			const toDuration = this.clip.duration;
			fadeOutAction.warp( 1, fromDuration / toDuration, duration );
			this.warp( toDuration / fromDuration, 1, duration );

		}

		return this;

	}

	crossFadeTo( fadeInAction, duration, warp = false ) {

		this.fadeOut( duration );
		fadeInAction.fadeIn( duration );

		if ( warp ) {

			const fromDuration = this.clip.duration;
			const toDuration = fadeInAction.clip.duration;
			this.warp( 1, fromDuration / toDuration, duration );
			fadeInAction.warp( toDuration / fromDuration, 1, duration );

		}

		return this;

	}

	getTrackIndex( name ) {

		return this._trackIndexMap.get( name ) ?? - 1;

	}

	getTrackValue( trackIndex ) {

		return this._interpolants[ trackIndex ].resultBuffer;

	}

	_advance( dt, mixerTime ) {

		if ( ! this.enabled ) {

			this._updateWeight( mixerTime );
			return;

		}

		if ( this._startTime !== null ) {

			if ( mixerTime < this._startTime ) {

				this._updateWeight( mixerTime );
				return;

			}

			this._startTime = null;

		}

		if ( this.paused ) {

			this._updateWeight( mixerTime );
			return;

		}

		if ( this._syncTarget !== null ) {

			this.time = this._syncTarget.time;
			this._updateWeight( mixerTime );
			if ( this._effectiveWeight > 0 ) {

				for ( let i = 0; i < this._interpolants.length; i ++ ) {

					this._interpolants[ i ].evaluate( this.time );

				}

			}

			return;

		}

		const duration = this.clip.duration;

		if ( duration === 0 ) {

			this._updateWeight( mixerTime );
			if ( this._effectiveWeight > 0 ) {

				for ( let i = 0; i < this._interpolants.length; i ++ ) {

					this._interpolants[ i ].evaluate( 0 );

				}

			}

			return;

		}

		const effectiveTS = this._computeEffectiveTimeScale( mixerTime );
		this.time += dt * effectiveTS;
		let clipTime = this.time;

		if ( this.loop === LoopRepeat || this.loop === LoopPingPong ) {

			if ( clipTime < 0 || clipTime >= duration ) {

				const loopDelta = Math.floor( clipTime / duration );
				clipTime -= duration * loopDelta;
				const absLoopDelta = Math.abs( loopDelta );
				this._loopCount += absLoopDelta;

				if ( this._loopCount >= this.repetitions ) {

					clipTime = effectiveTS >= 0 ? duration : 0;
					if ( this.clampWhenFinished ) this.paused = true;
					else this.enabled = false;
					this._updateEndings( true, true );
					this._mixer._dispatchFinished( this, effectiveTS >= 0 ? 1 : - 1 );

				} else {

					this._updateEndings( false, false );
					if ( absLoopDelta > 0 ) {

						this._mixer._dispatchLoop( this, absLoopDelta );

					}

				}

			} else {

				this._updateEndings( false, false );

			}

			if ( this.loop === LoopPingPong && ( this._loopCount & 1 ) === 1 ) {

				clipTime = duration - clipTime;

			}

		} else {

			this._updateEndings( true, true );
			if ( clipTime >= duration ) {

				clipTime = duration;
				if ( this.clampWhenFinished ) this.paused = true;
				else this.enabled = false;
				this._mixer._dispatchFinished( this, 1 );

			} else if ( clipTime < 0 ) {

				clipTime = 0;
				if ( this.clampWhenFinished ) this.paused = true;
				else this.enabled = false;
				this._mixer._dispatchFinished( this, - 1 );

			}

		}

		this._updateWeight( mixerTime );

		if ( this._effectiveWeight <= 0 ) return;

		for ( let i = 0; i < this._interpolants.length; i ++ ) {

			this._interpolants[ i ].evaluate( clipTime );

		}

	}

	_scheduleFade( duration, weightNow, weightThen ) {

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

	_scheduleTimeScale( duration, startTS, endTS ) {

		const now = this._mixer.time;
		let interp = this._timeScaleInterpolant;
		if ( interp === null ) {

			interp = this._mixer._lendControlInterpolant();
			this._timeScaleInterpolant = interp;

		}

		interp.parameterPositions[ 0 ] = now;
		interp.parameterPositions[ 1 ] = now + duration;
		interp.sampleValues[ 0 ] = startTS;
		interp.sampleValues[ 1 ] = endTS;
		return this;

	}

	_computeEffectiveTimeScale( mixerTime ) {

		const interp = this._timeScaleInterpolant;
		if ( interp !== null ) {

			const v = interp.evaluate( mixerTime )[ 0 ];
			if ( mixerTime > interp.parameterPositions[ 1 ] ) {

				this.timeScale = v;
				this.stopWarping();

			}

			return v;

		}

		return this.timeScale;

	}

	_updateWeight( time ) {

		let w = 0;
		if ( this.enabled ) {

			w = this.weight;
			const interp = this._weightInterpolant;
			if ( interp !== null ) {

				const v = interp.evaluate( time )[ 0 ];
				w *= v;
				if ( time > interp.parameterPositions[ 1 ] ) {

					this.stopFading();
					if ( v === 0 ) this.enabled = false;

				}

			}

		}

		this._effectiveWeight = w;

	}

	_updateEndings( atStart, atEnd ) {

		this._interpolantSettings.endingStart = atStart ? ZERO_CURVATURE : WRAP_AROUND;
		this._interpolantSettings.endingEnd = atEnd ? ZERO_CURVATURE : WRAP_AROUND;

	}

}
