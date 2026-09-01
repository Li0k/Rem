import { invoke } from '@tauri-apps/api/core';

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
  dropped: () => number;
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

type NativeEvent =
  | { kind: 'move'; t: number; dx: number; dy: number }
  | { kind: 'button_down'; t: number; button: number }
  | { kind: 'button_up'; t: number; button: number };

type NativeBatch = {
  events: NativeEvent[];
  dropped: number;
  pending: number;
};

type NativeStart = {
  backend: string;
  native: boolean;
  unadjusted: boolean;
  capacity: number;
  epochElapsedMs: number;
};

const lockPointer = async (canvas: HTMLCanvasElement) => {
  if (document.pointerLockElement === canvas) return true;
  try {
    await canvas.requestPointerLock({ unadjustedMovement: true });
    return true;
  } catch {
    try {
      await canvas.requestPointerLock();
      return false;
    } catch {
      return null;
    }
  }
};

const createBrowserSession = (
  canvas: HTMLCanvasElement,
  handlers: InputHandlers,
  unadjusted: boolean,
): InputSession => {
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

  return {
    id: 'browser-pointer-lock',
    label: 'browser-pointer-lock',
    native: false,
    unadjusted,
    dropped: () => 0,
    release() {
      if (released) return;
      released = true;
      removeListeners();
      if (document.pointerLockElement === canvas) document.exitPointerLock();
    },
  };
};

export const BROWSER_INPUT_BACKEND: InputBackend = {
  id: 'browser-pointer-lock',
  label: 'browser-pointer-lock',
  native: false,
  async acquire(canvas, handlers) {
    const unadjusted = await lockPointer(canvas);
    return unadjusted === null
      ? null
      : createBrowserSession(canvas, handlers, unadjusted);
  },
};

export const WINDOWS_NATIVE_INPUT_BACKEND: InputBackend = {
  id: 'windows-wm-input',
  label: 'windows-wm-input',
  native: true,
  async acquire(canvas, handlers) {
    let released = false;
    let raf = 0;
    let dropped = 0;
    const pointerLocked = await lockPointer(canvas);
    if (pointerLocked === null) return null;

    let started: NativeStart;
    const requestAt = performance.now();
    try {
      started = await invoke<NativeStart>('start_native_input');
    } catch {
      // Keep the already-acquired lock and its real unadjusted status so the
      // fallback does not need a second user gesture or mislabel adjusted input.
      return createBrowserSession(canvas, handlers, pointerLocked);
    }
    // Align Rust Instant-relative timestamps to the browser performance clock.
    // The response carries time already elapsed since native registration so
    // setup/IPC latency is not added to every event.
    const responseAt = performance.now();
    const clockOrigin = (requestAt + responseAt) / 2 - started.epochElapsedMs;
    const onLock = () => {
      if (!released && document.pointerLockElement !== canvas) handlers.lost();
    };
    document.addEventListener('pointerlockchange', onLock);

    const pump = async () => {
      if (released) return;
      let pending = 0;
      try {
        // One IPC call drains many raw packets. At common 1-8 kHz polling
        // rates a 1024-event batch comfortably spans one display frame.
        const batch = await invoke<NativeBatch>('drain_native_input', {
          limit: 1024,
        });
        dropped = batch.dropped;
        pending = batch.pending;
        for (const event of batch.events) {
          const timestamp = clockOrigin + event.t;
          if (event.kind === 'move')
            handlers.move(event.dx, event.dy, timestamp);
          else if (event.kind === 'button_down')
            handlers.buttonDown(event.button, timestamp);
          else handlers.buttonUp(event.button, timestamp);
        }
      } catch {
        if (!released) handlers.lost();
        return;
      }
      if (!released) {
        if (pending > 0) queueMicrotask(() => void pump());
        else raf = requestAnimationFrame(pump);
      }
    };
    void pump();

    return {
      id: started.backend,
      label: started.backend,
      native: started.native,
      // Raw relative counts bypass Windows pointer acceleration regardless of
      // whether WebView2 accepted the optional unadjusted pointer-lock flag.
      unadjusted: started.unadjusted,
      dropped: () => dropped,
      release() {
        if (released) return;
        released = true;
        cancelAnimationFrame(raf);
        document.removeEventListener('pointerlockchange', onLock);
        void invoke('stop_native_input');
        if (document.pointerLockElement === canvas) document.exitPointerLock();
      },
    };
  },
};

export const createPreferredInputBackend = (
  preferNative: boolean,
  nativeBackend: InputBackend = WINDOWS_NATIVE_INPUT_BACKEND,
  browserBackend: InputBackend = BROWSER_INPUT_BACKEND,
): InputBackend => ({
  id: preferNative ? nativeBackend.id : browserBackend.id,
  label: preferNative
    ? `${nativeBackend.label} (fallback: ${browserBackend.label})`
    : browserBackend.label,
  native: preferNative,
  async acquire(canvas, handlers) {
    if (preferNative) {
      const session = await nativeBackend.acquire(canvas, handlers);
      if (session) return session;
    }
    return browserBackend.acquire(canvas, handlers);
  },
});

const tauriRuntime =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
const windowsRuntime =
  typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);

/** Windows Tauri prefers WM_INPUT; web, macOS, and failed native startup use
 * the browser Pointer Lock adapter with accurate session metadata. */
export const INPUT_BACKEND = createPreferredInputBackend(
  tauriRuntime && windowsRuntime,
);
