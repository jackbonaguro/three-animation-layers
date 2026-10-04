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
  static characters: Character[] | null = null;

  static async initialize(domElement: HTMLElement) {
    this.initialized = true;

    GraphicsManager.renderer = new THREE.WebGLRenderer({ antialias: true });
    GraphicsManager.renderer.setPixelRatio(window.devicePixelRatio);
    GraphicsManager.scene = new THREE.Scene();
    GraphicsManager.scene.background = new THREE.Color(0xdddddd); // sky blue; use any color you like
    GraphicsManager.camera = new THREE.PerspectiveCamera(10, window.innerWidth / window.innerHeight, 0.1, 10000);
    GraphicsManager.camera.position.z = 500;
    GraphicsManager.scene.add(GraphicsManager.camera);

    GraphicsManager.controls = new OrbitControls(GraphicsManager.camera, GraphicsManager.renderer.domElement);
    GraphicsManager.controls.update();

    // Construct characters
    const character1 = await Character.loadFromFbx({ attack: false }); // locomotion only
    character1.rig.position.x = -30;
    const character2 = await Character.loadFromFbx({ locomotion: false }); // attack only
    character2.rig.position.x = -10;
    const character3 = await Character.loadFromFbx({ meshSpace: true }); // locomotion + attack in mesh space
    character3.rig.position.x = 10;
    const character4 = await Character.loadFromFbx(); // locomotion + attack in local space
    character4.rig.position.x = 30;
    GraphicsManager.characters = [character1, character2, character3, character4];
    GraphicsManager.characters.forEach(character => character.addToScene(GraphicsManager.scene));

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
    GraphicsManager.characters?.forEach(character => character.update(1 / 120));
    GraphicsManager.controls.update();
    GraphicsManager.renderer.render(GraphicsManager.scene, GraphicsManager.camera);
  }

}
