import { describe, expect, it, vi } from 'vitest';
import {
  createPreferredInputBackend,
  nativeFallbackReason,
  type InputBackend,
  type InputHandlers,
  type InputSession,
} from '../app/input';

const handlers: InputHandlers = {
  move: vi.fn(),
  buttonDown: vi.fn(),
  buttonUp: vi.fn(),
  lost: vi.fn(),
};
const canvas = {} as HTMLCanvasElement;
const session = (id: string, native: boolean): InputSession => ({
  id,
  label: id,
  native,
  unadjusted: native,
  diagnostics: () => ({
    backend: id,
    native,
    unadjusted: native,
    fallbackReason: native ? null : 'not-applicable',
    registered: native,
    capacity: native ? 16_384 : 0,
    packetCount: 0,
    eventCount: 0,
    movementPackets: 0,
    buttonEvents: 0,
    deviceCount: 0,
    peakPending: 0,
    currentPending: 0,
    dropped: 0,
    firstPacketMs: null,
    lastPacketMs: null,
    firstEventMs: null,
    lastEventMs: null,
    packetHz: null,
  }),
  finish: vi.fn(async function (this: InputSession) {
    return this.diagnostics();
  }),
  release: vi.fn(),
});
const backend = (
  id: string,
  native: boolean,
  result: InputSession | null,
): InputBackend => ({
  id,
  label: id,
  native,
  acquire: vi.fn(async () => result),
});

describe('input backend selection', () => {
  it('preserves a concrete native startup failure reason', () => {
    expect(nativeFallbackReason(new Error('registration denied'))).toBe(
      'native-start-failed: registration denied',
    );
  });

  it('bounds native startup errors so exported diagnostics stay valid', () => {
    const reason = nativeFallbackReason(new Error('x'.repeat(1_000)));
    expect(reason).toHaveLength(512);
    expect(reason).toMatch(/^native-start-failed: /);
  });

  it('uses native first on Windows Tauri', async () => {
    const native = backend('windows-wm-input', true, session('native', true));
    const browser = backend(
      'browser-pointer-lock',
      false,
      session('browser', false),
    );
    const selected = createPreferredInputBackend(true, native, browser);

    expect(await selected.acquire(canvas, handlers)).toMatchObject({
      id: 'native',
      native: true,
    });
    expect(native.acquire).toHaveBeenCalledOnce();
    expect(browser.acquire).not.toHaveBeenCalled();
  });

  it('falls back explicitly when native acquisition is unavailable', async () => {
    const native = backend('windows-wm-input', true, null);
    const browserSession = session('browser-pointer-lock', false);
    const browser = backend('browser-pointer-lock', false, browserSession);
    const selected = createPreferredInputBackend(true, native, browser);

    const acquired = await selected.acquire(canvas, handlers);
    expect(acquired?.id).toBe(browserSession.id);
    expect(acquired?.diagnostics().fallbackReason).toBe(
      'native-backend-unavailable',
    );
    expect(native.acquire).toHaveBeenCalledOnce();
    expect(browser.acquire).toHaveBeenCalledOnce();
  });

  it('does not probe native outside Windows Tauri', async () => {
    const native = backend('windows-wm-input', true, session('native', true));
    const browserSession = session('browser-pointer-lock', false);
    const browser = backend('browser-pointer-lock', false, browserSession);

    const acquired = await createPreferredInputBackend(
      false,
      native,
      browser,
    ).acquire(canvas, handlers);
    expect(acquired).toBe(browserSession);
    expect(acquired?.diagnostics().fallbackReason).toBe('not-applicable');
    expect(native.acquire).not.toHaveBeenCalled();
  });
});
