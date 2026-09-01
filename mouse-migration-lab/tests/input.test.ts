import { describe, expect, it, vi } from 'vitest';
import {
  createPreferredInputBackend,
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
  dropped: () => 0,
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

    expect(await selected.acquire(canvas, handlers)).toBe(browserSession);
    expect(native.acquire).toHaveBeenCalledOnce();
    expect(browser.acquire).toHaveBeenCalledOnce();
  });

  it('does not probe native outside Windows Tauri', async () => {
    const native = backend('windows-wm-input', true, session('native', true));
    const browserSession = session('browser-pointer-lock', false);
    const browser = backend('browser-pointer-lock', false, browserSession);

    expect(
      await createPreferredInputBackend(false, native, browser).acquire(
        canvas,
        handlers,
      ),
    ).toBe(browserSession);
    expect(native.acquire).not.toHaveBeenCalled();
  });
});
