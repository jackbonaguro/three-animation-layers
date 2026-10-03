import GraphicsManager from './GraphicsManager';

/**
 * Keyboard input for the demo. W/A/D pick a movement direction; Shift toggles
 * sprint. Shift alone with no direction key is idle.
 *
 * Sets {@link Character.setMovementDirection} (an angle, or null when no
 * direction key is held) and {@link Character.setSprinting} on the active
 * character — Character handles the polar→cartesian conversion into the
 * blend tree's (forward, strafe) coordinates.
 */
export default class InputManager {
  private static wHeld = false;
  private static shiftHeld = false;
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
    InputManager.shiftHeld = false;
    InputManager.aHeld = false;
    InputManager.dHeld = false;
    InputManager.syncLocomotion();
  }

  /**
   * Resolve held W/A/D to an angle in radians (0 forward, +π/2 right, −π/2 left),
   * or `null` if no direction key is held.
   */
  private static directionFromKeys(): number | null {
    const dx = InputManager.wHeld ? 1 : 0;
    const dy = (InputManager.dHeld ? 1 : 0) - (InputManager.aHeld ? 1 : 0);
    if (dx === 0 && dy === 0) return null;
    return Math.atan2(dy, dx);
  }

  private static syncLocomotion(): void {
    const character = GraphicsManager.character;
    if (!character) return;
    character.setMovementDirection(InputManager.directionFromKeys());
    character.setSprinting(InputManager.shiftHeld);
  }

  private static onKeyDown(ev: KeyboardEvent): void {
    const t = ev.target as Node | null;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;

    if (ev.key === 'w' || ev.key === 'W') {
      InputManager.wHeld = true;
      InputManager.syncLocomotion();
    } else if (ev.key === 'Shift') {
      InputManager.shiftHeld = true;
      InputManager.syncLocomotion();
    } else if (ev.key === 'a' || ev.key === 'A') {
      InputManager.aHeld = true;
      InputManager.syncLocomotion();
    } else if (ev.key === 'd' || ev.key === 'D') {
      InputManager.dHeld = true;
      InputManager.syncLocomotion();
    } else if (ev.key === ' ') {
      GraphicsManager.character?.triggerAttack();
    }
  }

  private static onKeyUp(ev: KeyboardEvent): void {
    const t = ev.target as Node | null;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;

    if (ev.key === 'w' || ev.key === 'W') {
      InputManager.wHeld = false;
      InputManager.syncLocomotion();
    } else if (ev.key === 'Shift') {
      InputManager.shiftHeld = false;
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
