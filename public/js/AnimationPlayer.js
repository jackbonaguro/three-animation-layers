import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { LayeredMixer } from './LayeredMixer.js';
import { AnimationLayerMask } from './AnimationLayerMask.js';

const FADE_SECONDS = 0.15;

/**
 * Animated character: rig root, LayeredMixer, and layered clip setup (matches the React demo).
 */
export default class AnimationPlayer {

	constructor( rig, clips ) {

		this.rig = rig;
		this.mixer = new LayeredMixer( rig );
		this.overlayLayer = null;
		this.punchAction = null;
		this.idleAction = null;
		this.runningAction = null;
		this._runningHeld = false;
		this._punchEndFadeScheduled = false;
		this.skeletonHelper = null;
		this.setupAnimationLayers( clips );

	}

	addToScene( scene ) {

		scene.add( this.rig );
		this.skeletonHelper = new THREE.SkeletonHelper( this.rig );
		scene.add( this.skeletonHelper );

	}

	update( deltaSeconds ) {

		this.syncPunchOutroFade();
		this.mixer.update( deltaSeconds );
		this.syncPunchOutroFade();

	}

	syncPunchOutroFade() {

		const a = this.punchAction;
		if ( ! a || ! a.enabled || this._punchEndFadeScheduled ) return;
		const dur = a.clip.duration;
		if ( dur <= 0 ) return;
		const fade = FADE_SECONDS;
		const remaining = Math.max( 0, dur - a.time );
		if ( remaining > fade + 1e-6 ) return;
		const outDuration = remaining > 1e-6 ? remaining : fade;
		a.fadeOut( outDuration );
		this._punchEndFadeScheduled = true;

	}

	triggerPunch() {

		if ( ! this.punchAction ) return;
		this._punchEndFadeScheduled = false;
		this.punchAction.reset();
		this.punchAction.fadeIn( FADE_SECONDS );

	}

	setRunningHeld( held ) {

		if ( ! this.runningAction ) return;
		if ( held === this._runningHeld ) return;
		this._runningHeld = held;
		const t = FADE_SECONDS;
		if ( held ) {

			if ( this.idleAction ) this.idleAction.fadeOut( t );
			this.runningAction.reset();
			this.runningAction.fadeIn( t );

		} else {

			this.runningAction.fadeOut( t );
			if ( this.idleAction ) {

				this.idleAction.play();
				this.idleAction.fadeIn( t );

			}

		}

	}

	static async loadFromFbx( url = './testChar.backup.fbx', scale = 0.05 ) {

		const rig = await AnimationPlayer.loadFbxRig( url, scale );
		const clips = AnimationPlayer.extractClipsFromRig( rig );
		return new AnimationPlayer( rig, clips );

	}

	static async loadFbxRig( url, scale ) {

		const loader = new FBXLoader();
		const rig = await new Promise( ( res, rej ) => {

			loader.load( url, res, undefined, rej );

		} );
		rig.traverse( function ( node ) {

			if ( node.isMesh ) {

				node.castShadow = true;

			}

		} );
		rig.scale.multiplyScalar( scale );
		return rig;

	}

	static extractClipsFromRig( rig ) {

		return {
			tposeClip: AnimationPlayer.nameToClip( rig, 'TPose' ),
			idleClip: AnimationPlayer.nameToClip( rig, 'Idle' ),
			runningClip: AnimationPlayer.nameToClip( rig, 'Running' ),
			punchClip: AnimationPlayer.nameToClip( rig, 'Punch_1' ),
		};

	}

	setupAnimationLayers( clips ) {

		const baseLayer = this.mixer.addLayer( 'base' );
		if ( clips.idleClip ) {

			this.idleAction = baseLayer.play( clips.idleClip );

		}

		if ( clips.runningClip ) {

			this.runningAction = baseLayer.play( clips.runningClip );
			this.runningAction.enabled = false;
			this.runningAction.syncEffectiveWeight( this.mixer.time );

		}

		if ( clips.punchClip ) {

			const upperBodyMask = new AnimationLayerMask( {
				'mixamorigSpine.quaternion': 1,
				'mixamorigSpine1.quaternion': 1,
				'mixamorigSpine2.quaternion': 1,
				'mixamorigNeck.quaternion': 1,
				'mixamorigHead.quaternion': 1,
				'mixamorigLeftShoulder.quaternion': 1,
				'mixamorigLeftArm.quaternion': 1,
				'mixamorigLeftForeArm.quaternion': 1,
				'mixamorigLeftHand.quaternion': 1,
				'mixamorigRightShoulder.quaternion': 1,
				'mixamorigRightArm.quaternion': 1,
				'mixamorigRightForeArm.quaternion': 1,
				'mixamorigRightHand.quaternion': 1,
			} );

			this.overlayLayer = this.mixer.addLayer( 'overlay', { mask: upperBodyMask } );
			this.punchAction = this.overlayLayer.play( clips.punchClip );
			this.punchAction.loop = THREE.LoopOnce;
			this.punchAction.clampWhenFinished = true;
			this.punchAction.enabled = false;
			this.punchAction.syncEffectiveWeight( this.mixer.time );

		}

	}

	static nameToClip( fbx, name ) {

		let clip = fbx.animations.find( ( a ) => a.name.includes( name ) )?.clone();
		if ( ! clip ) return;
		clip = AnimationPlayer.normalizeClip( clip );
		return clip;

	}

	static normalizeClip( clip ) {

		const filterWords = [ 'position', 'scale' ];
		const filteredTracks = clip.tracks.filter( ( track ) => {

			return ! filterWords.some( ( fw ) => track.name.toLowerCase().includes( fw ) );

		} );
		const hipsPositionTrack = clip.tracks.find( ( track ) => {

			return track.name.toLowerCase().includes( 'hips' ) && track.name.toLowerCase().includes( 'position' );

		} );
		if ( hipsPositionTrack ) {

			for ( let i = 0; i < hipsPositionTrack.values.length; i ++ ) {

				if ( i % 3 !== 1 ) {

					hipsPositionTrack.values[ i ] = 0;

				}

			}

			filteredTracks.push( hipsPositionTrack );

		}

		clip.tracks = filteredTracks;
		return clip;

	}

}
