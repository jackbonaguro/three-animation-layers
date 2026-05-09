import GraphicsManager from './GraphicsManager';

/**
 * Keyboard input for the demo. W/A/D pick a movement direction; E is a speed
 * modifier (walk → run). E alone with no direction key is idle.
 */
export default class InputManager {
  /** Forward velocity at the "walk" tier, matching the walk threshold's x. */
  private static readonly WALK_SPEED = 0.5;
  /** Forward velocity at the "run" tier, matching the run threshold's x. */
  private static readonly RUN_SPEED = 1;

  private static wHeld = false;
  private static eHeld = false;
  private static aHeld = false;
  private static dHeld = false;

  static init(): void {
    window.addEventListener('keydown', InputManager.onKeyDown);
    window.addEventListener('keyup', InputManager.onKeyUp);
  }

  static dispose(): void {
    window.removeEventListener('keydown', InputManager.onKeyDown);
    window.removeEventListener('keyup', InputManager.onKeyUp);
    InputManager.wHeld = false;
    InputManager.eHeld = false;
    InputManager.aHeld = false;
    InputManager.dHeld = false;
    GraphicsManager.setLocomotionSpeed(0);
    GraphicsManager.setLocomotionStrafe(0);
  }

  /**
   * Resolve held keys to a (forward, strafe) velocity vector. Direction comes
   * from W/A/D; magnitude is walk- or run-speed depending on E. With no
   * direction key the magnitude is zero so we sit at idle regardless of E.
   */
  private static locomotionVelocityFromKeys(): { x: number; y: number } {
    let dx = 0;
    let dy = 0;
    if (InputManager.wHeld) dx += 1;
    if (InputManager.aHeld) dy -= 1;
    if (InputManager.dHeld) dy += 1;
    const len = Math.hypot(dx, dy);
    if (len === 0) return { x: 0, y: 0 };
    const speed = InputManager.eHeld
      ? InputManager.RUN_SPEED
      : InputManager.WALK_SPEED;
    return { x: (dx / len) * speed, y: (dy / len) * speed };
  }

  private static syncLocomotion(): void {
    const v = InputManager.locomotionVelocityFromKeys();
    GraphicsManager.setLocomotionSpeed(v.x);
    GraphicsManager.setLocomotionStrafe(v.y);
  }

  private static onKeyDown(ev: KeyboardEvent): void {
    const t = ev.target as Node | null;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;

    if (ev.key === 'w' || ev.key === 'W') {
      InputManager.wHeld = true;
      InputManager.syncLocomotion();
    } else if (ev.key === 'e' || ev.key === 'E') {
      InputManager.eHeld = true;
      InputManager.syncLocomotion();
    } else if (ev.key === 'a' || ev.key === 'A') {
      InputManager.aHeld = true;
      InputManager.syncLocomotion();
    } else if (ev.key === 'd' || ev.key === 'D') {
      InputManager.dHeld = true;
      InputManager.syncLocomotion();
    } else if (ev.key === ' ') {
      GraphicsManager.character?.triggerPunch();
    }
  }

  private static onKeyUp(ev: KeyboardEvent): void {
    const t = ev.target as Node | null;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;

    if (ev.key === 'w' || ev.key === 'W') {
      InputManager.wHeld = false;
      InputManager.syncLocomotion();
    } else if (ev.key === 'e' || ev.key === 'E') {
      InputManager.eHeld = false;
      InputManager.syncLocomotion();
    } else if (ev.key === 'a' || ev.key === 'A') {
      InputManager.aHeld = false;
      InputManager.syncLocomotion();
    } else if (ev.key === 'd' || ev.key === 'D') {
      InputManager.dHeld = false;
      InputManager.syncLocomotion();
    }
  }
}
