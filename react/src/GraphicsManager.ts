import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import Character from './Character';

export default class GraphicsManager {
  static initialized: boolean = false;
  static renderer: THREE.WebGLRenderer;
  static domElement: HTMLElement;
  static scene: THREE.Scene;
  static camera: THREE.PerspectiveCamera;
  static controls: OrbitControls;
  static character: Character | null = null;

  /** Locomotion blend target: 0 = idle, 0.5 = punch, 1 = run (smoothed in {@link Character.update}). */
  static setLocomotionSpeed(speed: number): void {
    GraphicsManager.character?.setLocomotionSpeed(speed);
  }

  static async initialize(domElement: HTMLElement) {
    this.initialized = true;

    GraphicsManager.renderer = new THREE.WebGLRenderer({ antialias: true });
    GraphicsManager.renderer.setPixelRatio(window.devicePixelRatio);
    GraphicsManager.scene = new THREE.Scene();
    GraphicsManager.scene.background = new THREE.Color(0xdddddd); // sky blue; use any color you like
    GraphicsManager.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    GraphicsManager.camera.position.z = 50;
    GraphicsManager.camera.position.y = 10;
    GraphicsManager.scene.add(GraphicsManager.camera);

    GraphicsManager.controls = new OrbitControls(GraphicsManager.camera, GraphicsManager.renderer.domElement);
    GraphicsManager.controls.update();

    GraphicsManager.character = await Character.loadFromFbx();
    GraphicsManager.character.addToScene(GraphicsManager.scene);

    const ambientLight = new THREE.AmbientLight( 0xffffff, 1 );
    GraphicsManager.scene.add( ambientLight );

    const directionalLight = new THREE.DirectionalLight(0xffffff, 2);
    directionalLight.position.set(100, 200, 100);
    directionalLight.castShadow = true;
    GraphicsManager.scene.add(directionalLight);

    domElement.appendChild(GraphicsManager.renderer.domElement);
    GraphicsManager.domElement = domElement;

    GraphicsManager.renderer.setAnimationLoop(GraphicsManager.update);
    window.addEventListener('resize', GraphicsManager.resize);
    GraphicsManager.resize();
  }

  static resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;

    const canvas = GraphicsManager.renderer!.domElement;
    canvas.setAttribute('width', w.toString());
    canvas.setAttribute('height', h.toString());
    if (GraphicsManager.camera instanceof THREE.PerspectiveCamera) {
      GraphicsManager.camera!.aspect = w / h;
      GraphicsManager.camera!.updateProjectionMatrix();
    }
    GraphicsManager.renderer!.setSize(w, h);
  }

  static update() {
    GraphicsManager.character?.update(1 / 120);
    GraphicsManager.controls.update();
    GraphicsManager.renderer.render(GraphicsManager.scene, GraphicsManager.camera);
  }

}
