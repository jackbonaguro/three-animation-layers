import GraphicsManager from './GraphicsManager';

/**
 * Keyboard input for the demo: hold W to run, Space for a one-shot punch.
 */
export default class InputManager {
  static init(): void {
    window.addEventListener('keydown', InputManager.onKeyDown);
    window.addEventListener('keyup', InputManager.onKeyUp);
  }

  static dispose(): void {
    window.removeEventListener('keydown', InputManager.onKeyDown);
    window.removeEventListener('keyup', InputManager.onKeyUp);
    GraphicsManager.setRunningHeld(false);
  }

  private static onKeyDown(ev: KeyboardEvent): void {
    const t = ev.target as Node | null;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;

    if (ev.code === 'Space') {
      if (ev.repeat) return;
      ev.preventDefault();
      GraphicsManager.triggerPunch();
      return;
    }

    if (ev.key === 'w' || ev.key === 'W') {
      if (ev.repeat) return;
      GraphicsManager.setRunningHeld(true);
    }
  }

  private static onKeyUp(ev: KeyboardEvent): void {
    const t = ev.target as Node | null;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;

    if (ev.key === 'w' || ev.key === 'W') {
      GraphicsManager.setRunningHeld(false);
    }
  }
}
