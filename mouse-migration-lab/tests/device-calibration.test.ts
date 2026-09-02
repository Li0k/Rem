import { describe, expect, it } from 'vitest';
import {
  isDeviceMeasurement,
  summarizeDeviceMeasurement,
  type MovementSample,
} from '../app/device-calibration';
import type { InputDiagnostics } from '../app/input';

const diagnostics = (
  overrides: Partial<InputDiagnostics> = {},
): InputDiagnostics => ({
  backend: 'windows-wm-input',
  native: true,
  unadjusted: true,
  fallbackReason: null,
  registered: true,
  capacity: 16_384,
  packetCount: 1_000,
  eventCount: 1_000,
  movementPackets: 1_000,
  buttonEvents: 0,
  deviceCount: 1,
  peakPending: 8,
  currentPending: 0,
  dropped: 0,
  firstPacketMs: 0,
  lastPacketMs: 999,
  firstEventMs: 0,
  lastEventMs: 999,
  packetHz: 1_000,
  ...overrides,
});

const samples = (
  count: number,
  intervalMs: number,
  totalDx: number,
): MovementSample[] =>
  Array.from({ length: count }, (_, index) => ({
    dx: totalDx / count,
    dy: 0,
    timestamp: index * intervalMs,
  }));

describe('device calibration', () => {
  it('reports an observed input rate and estimates DPI from unadjusted counts', () => {
    const result = summarizeDeviceMeasurement(
      samples(1_001, 1, 3_150),
      diagnostics(),
      10,
      '2026-09-02T00:00:00.000Z',
    );

    expect(result.observedEventRateHz).toBe(1_000);
    expect(result.estimatedDpi).toBe(800);
    expect(result.calibrationCounts).toBe(3_150);
    expect(result.quality).toBe('good');
    expect(isDeviceMeasurement(result)).toBe(true);
  });

  it('does not claim a DPI estimate from adjusted browser movement', () => {
    const result = summarizeDeviceMeasurement(
      samples(500, 2, 3_150),
      diagnostics({
        backend: 'browser-pointer-lock',
        native: false,
        unadjusted: false,
        registered: false,
        capacity: 0,
        deviceCount: 0,
      }),
      10,
    );

    expect(result.estimatedDpi).toBeNull();
    expect(result.calibrationCounts).toBeNull();
  });

  it('marks short or sparse captures as insufficient', () => {
    const result = summarizeDeviceMeasurement(
      samples(20, 10, 200),
      diagnostics(),
      10,
    );

    expect(result.quality).toBe('insufficient');
    expect(result.estimatedDpi).toBeNull();
  });

  it('rejects malformed persisted measurements', () => {
    const result = summarizeDeviceMeasurement(
      samples(100, 2, 1_000),
      diagnostics(),
      10,
    );
    expect(
      isDeviceMeasurement({ ...result, observedEventRateHz: Infinity }),
    ).toBe(false);
  });
});
