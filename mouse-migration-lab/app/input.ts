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
  diagnostics: () => InputDiagnostics;
  finish: () => Promise<InputDiagnostics>;
  release: () => void;
};

export type InputDiagnostics = {
  backend: string;
  native: boolean;
  unadjusted: boolean;
  fallbackReason: string | null;
  registered: boolean;
  capacity: number;
  packetCount: number;
  eventCount: number;
  movementPackets: number;
  buttonEvents: number;
  deviceCount: number;
  peakPending: number;
  currentPending: number;
  dropped: number;
  firstPacketMs: number | null;
  lastPacketMs: number | null;
  firstEventMs: number | null;
  lastEventMs: number | null;
  packetHz: number | null;
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
  rawPackets: number;
  emittedEvents: number;
  movementPackets: number;
  buttonEvents: number;
  deviceCount: number;
  peakPending: number;
  dropped: number;
  pending: number;
  firstPacketMs: number | null;
  lastPacketMs: number | null;
  firstEventMs: number | null;
  lastEventMs: number | null;
};

type NativeStart = {
  backend: string;
  native: boolean;
  unadjusted: boolean;
  capacity: number;
  epochElapsedMs: number;
  registered: boolean;
};

const packetRate = (
  count: number,
  first: number | null,
  last: number | null,
) =>
  count > 1 && first !== null && last !== null && last > first
    ? ((count - 1) * 1000) / (last - first)
    : null;

export const nativeFallbackReason = (error: unknown) =>
  `native-start-failed: ${error instanceof Error ? error.message : String(error)}`.slice(
    0,
    512,
  );

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
  fallbackReason = 'not-applicable',
): InputSession => {
  let released = false;
  const epoch = performance.now();
  let packetCount = 0;
  let movementPackets = 0;
  let buttonEvents = 0;
  let firstEventMs: number | null = null;
  let lastEventMs: number | null = null;
  const record = (timestamp: number, movement: boolean) => {
    const relativeTimestamp = Math.max(0, timestamp - epoch);
    packetCount += 1;
    if (movement) movementPackets += 1;
    else buttonEvents += 1;
    firstEventMs ??= relativeTimestamp;
    lastEventMs = relativeTimestamp;
  };
  const onMove = (event: MouseEvent) => {
    if (document.pointerLockElement !== canvas) return;
    record(event.timeStamp, true);
    handlers.move(event.movementX, event.movementY, event.timeStamp);
  };
  const onDown = (event: MouseEvent) => {
    if (document.pointerLockElement !== canvas) return;
    record(event.timeStamp, false);
    handlers.buttonDown(event.button, event.timeStamp);
  };
  const onUp = (event: MouseEvent) => {
    if (document.pointerLockElement !== canvas) return;
    record(event.timeStamp, false);
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

  const diagnostics = (): InputDiagnostics => ({
    backend: 'browser-pointer-lock',
    native: false,
    unadjusted,
    fallbackReason,
    registered: false,
    capacity: 0,
    packetCount,
    eventCount: packetCount,
    movementPackets,
    buttonEvents,
    deviceCount: 0,
    peakPending: 0,
    currentPending: 0,
    dropped: 0,
    firstPacketMs: firstEventMs,
    lastPacketMs: lastEventMs,
    firstEventMs,
    lastEventMs,
    packetHz: packetRate(packetCount, firstEventMs, lastEventMs),
  });
  const release = () => {
    if (released) return;
    released = true;
    removeListeners();
    if (document.pointerLockElement === canvas) document.exitPointerLock();
  };

  return {
    id: 'browser-pointer-lock',
    label: 'browser-pointer-lock',
    native: false,
    unadjusted,
    diagnostics,
    async finish() {
      const final = diagnostics();
      release();
      return final;
    },
    release,
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
    let finishing = false;
    let raf = 0;
    let pumpTask: Promise<void> | null = null;
    let latest: NativeBatch = {
      events: [],
      rawPackets: 0,
      emittedEvents: 0,
      movementPackets: 0,
      buttonEvents: 0,
      deviceCount: 0,
      peakPending: 0,
      dropped: 0,
      pending: 0,
      firstPacketMs: null,
      lastPacketMs: null,
      firstEventMs: null,
      lastEventMs: null,
    };
    const pointerLocked = await lockPointer(canvas);
    if (pointerLocked === null) return null;

    let started: NativeStart;
    const requestAt = performance.now();
    try {
      started = await invoke<NativeStart>('start_native_input');
    } catch (error) {
      // Keep the already-acquired lock and its real unadjusted status so the
      // fallback does not need a second user gesture or mislabel adjusted input.
      return createBrowserSession(
        canvas,
        handlers,
        pointerLocked,
        nativeFallbackReason(error),
      );
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

    const applyBatch = (batch: NativeBatch) => {
      latest = batch;
      for (const event of batch.events) {
        const timestamp = clockOrigin + event.t;
        if (event.kind === 'move') handlers.move(event.dx, event.dy, timestamp);
        else if (event.kind === 'button_down')
          handlers.buttonDown(event.button, timestamp);
        else handlers.buttonUp(event.button, timestamp);
      }
    };
    const pump = () => {
      if (released || finishing) return;
      let pending = 0;
      const task = (async () => {
        try {
          // One IPC call drains many raw packets. At common 1-8 kHz polling
          // rates a 1024-event batch comfortably spans one display frame.
          const batch = await invoke<NativeBatch>('drain_native_input', {
            limit: 1024,
          });
          applyBatch(batch);
          pending = batch.pending;
        } catch {
          if (!released && !finishing) handlers.lost();
        }
      })();
      pumpTask = task;
      void task.finally(() => {
        if (pumpTask === task) pumpTask = null;
        if (released || finishing) return;
        if (pending > 0) queueMicrotask(pump);
        else raf = requestAnimationFrame(pump);
      });
    };
    pump();

    const diagnostics = (): InputDiagnostics => ({
      backend: started.backend,
      native: started.native,
      unadjusted: started.unadjusted,
      fallbackReason: null,
      registered: started.registered,
      capacity: started.capacity,
      packetCount: latest.rawPackets,
      eventCount: latest.emittedEvents,
      movementPackets: latest.movementPackets,
      buttonEvents: latest.buttonEvents,
      deviceCount: latest.deviceCount,
      peakPending: latest.peakPending,
      currentPending: latest.pending,
      dropped: latest.dropped,
      firstPacketMs: latest.firstPacketMs,
      lastPacketMs: latest.lastPacketMs,
      firstEventMs: latest.firstEventMs,
      lastEventMs: latest.lastEventMs,
      packetHz: packetRate(
        latest.rawPackets,
        latest.firstPacketMs,
        latest.lastPacketMs,
      ),
    });
    const releaseLocalResources = () => {
      released = true;
      cancelAnimationFrame(raf);
      document.removeEventListener('pointerlockchange', onLock);
      if (document.pointerLockElement === canvas) document.exitPointerLock();
    };

    return {
      id: started.backend,
      label: started.backend,
      native: started.native,
      // Raw relative counts bypass Windows pointer acceleration regardless of
      // whether WebView2 accepted the optional unadjusted pointer-lock flag.
      unadjusted: started.unadjusted,
      diagnostics,
      async finish() {
        if (released) return diagnostics();
        finishing = true;
        cancelAnimationFrame(raf);
        await pumpTask;
        try {
          const finalBatch = await invoke<NativeBatch>('stop_native_input');
          applyBatch(finalBatch);
        } finally {
          releaseLocalResources();
        }
        return diagnostics();
      },
      release() {
        if (released) return;
        finishing = true;
        releaseLocalResources();
        void invoke('stop_native_input');
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
    const browser = await browserBackend.acquire(canvas, handlers);
    if (!browser || !preferNative) return browser;
    return {
      ...browser,
      diagnostics: () => ({
        ...browser.diagnostics(),
        fallbackReason: 'native-backend-unavailable',
      }),
    };
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
