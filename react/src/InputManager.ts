import GraphicsManager from './GraphicsManager';

/**
 * Keyboard input for the demo: hold E for speed 0.5 (punch blend), W for speed 1 (run).
 * W wins if both are held. Releases fall back to the other key or idle (0).
 */
export default class InputManager {
  private static wHeld = false;
  private static eHeld = false;

  static init(): void {
    window.addEventListener('keydown', InputManager.onKeyDown);
    window.addEventListener('keyup', InputManager.onKeyUp);
  }

  static dispose(): void {
    window.removeEventListener('keydown', InputManager.onKeyDown);
    window.removeEventListener('keyup', InputManager.onKeyUp);
    InputManager.wHeld = false;
    InputManager.eHeld = false;
    GraphicsManager.setLocomotionSpeed(0);
  }

  private static locomotionSpeedFromKeys(): number {
    if (InputManager.eHeld) return 1;
    if (InputManager.wHeld) return 0.5;
    return 0;
  }

  private static syncLocomotionSpeed(): void {
    GraphicsManager.setLocomotionSpeed(InputManager.locomotionSpeedFromKeys());
  }

  private static onKeyDown(ev: KeyboardEvent): void {
    const t = ev.target as Node | null;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;

    if (ev.key === 'w' || ev.key === 'W') {
      InputManager.wHeld = true;
      InputManager.syncLocomotionSpeed();
    } else if (ev.key === 'e' || ev.key === 'E') {
      InputManager.eHeld = true;
      InputManager.syncLocomotionSpeed();
    } else if (ev.key === ' ') {
      GraphicsManager.character?.triggerPunch();
    }
  }

  private static onKeyUp(ev: KeyboardEvent): void {
    const t = ev.target as Node | null;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;

    if (ev.key === 'w' || ev.key === 'W') {
      InputManager.wHeld = false;
      InputManager.syncLocomotionSpeed();
    } else if (ev.key === 'e' || ev.key === 'E') {
      InputManager.eHeld = false;
      InputManager.syncLocomotionSpeed();
    }
  }
}
