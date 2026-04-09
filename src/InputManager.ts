import GraphicsManager from './GraphicsManager';

/**
 * Keyboard and other input. Calls into GraphicsManager for animation control only.
 */
export default class InputManager {
  static init(): void {
    window.addEventListener('keydown', InputManager.onKeyDown);
  }

  static dispose(): void {
    window.removeEventListener('keydown', InputManager.onKeyDown);
  }

  private static onKeyDown(ev: KeyboardEvent): void {
    if (ev.repeat) return;

    const t = ev.target as Node | null;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;

    if (ev.code === 'Space') {
      ev.preventDefault();
      GraphicsManager.togglePunchLayer();
      return;
    }

    if (ev.key === 'w' || ev.key === 'W') {
      GraphicsManager.toggleRunningLayer();
    }
  }
}
