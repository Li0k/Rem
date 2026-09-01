export type InputHandlers = {
  move: (dx: number, dy: number, timestamp: number) => void;
  buttonDown: (button: number, timestamp: number) => void;
  buttonUp: (button: number, timestamp: number) => void;
  lost: () => void;
};

export type InputSession = {
  id: string;
  label: string;
  native: boolean;
  unadjusted: boolean;
  release: () => void;
};

export type InputBackend = {
  id: string;
  label: string;
  native: boolean;
  acquire: (
    canvas: HTMLCanvasElement,
    handlers: InputHandlers,
  ) => Promise<InputSession | null>;
};

/**
 * The browser adapter owns every browser-specific listener and Pointer Lock
 * lifecycle. A future Windows WM_INPUT adapter can implement the same contract
 * without leaking DOM mouse events into the experiment runtime.
 */
export const INPUT_BACKEND: InputBackend = {
  id: 'browser-pointer-lock',
  label: 'browser-pointer-lock',
  native: false,
  async acquire(canvas, handlers) {
    let released = false;
    const onMove = (event: MouseEvent) => {
      if (document.pointerLockElement !== canvas) return;
      handlers.move(event.movementX, event.movementY, event.timeStamp);
    };
    const onDown = (event: MouseEvent) => {
      if (document.pointerLockElement !== canvas) return;
      handlers.buttonDown(event.button, event.timeStamp);
    };
    const onUp = (event: MouseEvent) => {
      if (document.pointerLockElement !== canvas) return;
      handlers.buttonUp(event.button, event.timeStamp);
    };
    const onLock = () => {
      if (!released && document.pointerLockElement !== canvas) handlers.lost();
    };
    const removeListeners = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('pointerlockchange', onLock);
    };
    document.addEventListener('mousemove', onMove, { passive: true });
    document.addEventListener('mousedown', onDown);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('pointerlockchange', onLock);

    let unadjusted = true;
    try {
      await canvas.requestPointerLock({ unadjustedMovement: true });
    } catch {
      unadjusted = false;
      try {
        await canvas.requestPointerLock();
      } catch {
        released = true;
        removeListeners();
        return null;
      }
    }

    return {
      id: this.id,
      label: this.label,
      native: this.native,
      unadjusted,
      release() {
        if (released) return;
        released = true;
        removeListeners();
        if (document.pointerLockElement === canvas) document.exitPointerLock();
      },
    };
  },
};
