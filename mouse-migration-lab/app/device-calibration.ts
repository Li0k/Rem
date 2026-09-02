import type { InputDiagnostics } from './input';

export type DeviceMeasurementQuality = 'good' | 'unstable' | 'insufficient';

export type DeviceMeasurement = {
  measuredAt: string;
  backend: string;
  native: boolean;
  unadjusted: boolean;
  durationMs: number;
  movementEvents: number;
  deviceCount: number;
  observedEventRateHz: number | null;
  intervalP50Ms: number | null;
  intervalP95Ms: number | null;
  intervalJitterRatio: number | null;
  quality: DeviceMeasurementQuality;
  calibrationDistanceCm: number | null;
  calibrationCounts: number | null;
  estimatedDpi: number | null;
};

export type MovementSample = {
  dx: number;
  dy: number;
  timestamp: number;
};

const quantile = (values: number[], fraction: number) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))
  ];
};

export function summarizeDeviceMeasurement(
  samples: MovementSample[],
  diagnostics: InputDiagnostics,
  calibrationDistanceCm: number | null,
  measuredAt = new Date().toISOString(),
): DeviceMeasurement {
  const intervals: number[] = [];
  for (let index = 1; index < samples.length; index += 1) {
    const interval = samples[index].timestamp - samples[index - 1].timestamp;
    if (Number.isFinite(interval) && interval > 0 && interval <= 100)
      intervals.push(interval);
  }
  const p50 = quantile(intervals, 0.5);
  const p95 = quantile(intervals, 0.95);
  const observedEventRateHz =
    p50 !== null && p50 > 0 ? Math.min(100_000, 1000 / p50) : null;
  const jitter =
    p50 !== null && p95 !== null && p50 > 0 ? (p95 - p50) / p50 : null;
  const durationMs =
    samples.length > 1
      ? Math.max(0, samples.at(-1)!.timestamp - samples[0].timestamp)
      : 0;
  const netX = samples.reduce((total, sample) => total + sample.dx, 0);
  const netY = samples.reduce((total, sample) => total + sample.dy, 0);
  const calibrationCounts = Math.round(
    Math.max(Math.abs(netX), Math.abs(netY)),
  );
  const enoughSamples = samples.length >= 50 && durationMs >= 500;
  const validDistance =
    calibrationDistanceCm !== null &&
    Number.isFinite(calibrationDistanceCm) &&
    calibrationDistanceCm >= 2 &&
    calibrationDistanceCm <= 100;
  const estimatedDpi =
    enoughSamples &&
    diagnostics.unadjusted &&
    validDistance &&
    calibrationCounts >= 100
      ? Math.round(calibrationCounts / (calibrationDistanceCm! / 2.54))
      : null;
  const quality: DeviceMeasurementQuality = !enoughSamples
    ? 'insufficient'
    : jitter !== null && jitter > 0.75
      ? 'unstable'
      : 'good';

  return {
    measuredAt,
    backend: diagnostics.backend,
    native: diagnostics.native,
    unadjusted: diagnostics.unadjusted,
    durationMs,
    movementEvents: samples.length,
    deviceCount: diagnostics.deviceCount,
    observedEventRateHz,
    intervalP50Ms: p50,
    intervalP95Ms: p95,
    intervalJitterRatio: jitter,
    quality,
    calibrationDistanceCm: validDistance ? calibrationDistanceCm : null,
    calibrationCounts:
      validDistance && diagnostics.unadjusted ? calibrationCounts : null,
    estimatedDpi,
  };
}

export function isDeviceMeasurement(
  value: unknown,
): value is DeviceMeasurement {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  const nullableRange = (entry: unknown, min: number, max: number) =>
    entry === null ||
    (typeof entry === 'number' &&
      Number.isFinite(entry) &&
      entry >= min &&
      entry <= max);
  return (
    typeof item.measuredAt === 'string' &&
    item.measuredAt.length > 0 &&
    item.measuredAt.length <= 64 &&
    typeof item.backend === 'string' &&
    item.backend.length > 0 &&
    item.backend.length <= 128 &&
    typeof item.native === 'boolean' &&
    typeof item.unadjusted === 'boolean' &&
    typeof item.durationMs === 'number' &&
    Number.isFinite(item.durationMs) &&
    item.durationMs >= 0 &&
    item.durationMs <= 120_000 &&
    typeof item.movementEvents === 'number' &&
    Number.isSafeInteger(item.movementEvents) &&
    item.movementEvents >= 0 &&
    item.movementEvents <= 1_000_000 &&
    typeof item.deviceCount === 'number' &&
    Number.isSafeInteger(item.deviceCount) &&
    item.deviceCount >= 0 &&
    item.deviceCount <= 1_024 &&
    nullableRange(item.observedEventRateHz, 0, 100_000) &&
    nullableRange(item.intervalP50Ms, 0, 100) &&
    nullableRange(item.intervalP95Ms, 0, 100) &&
    nullableRange(item.intervalJitterRatio, 0, 1_000) &&
    (item.quality === 'good' ||
      item.quality === 'unstable' ||
      item.quality === 'insufficient') &&
    nullableRange(item.calibrationDistanceCm, 2, 100) &&
    nullableRange(item.calibrationCounts, 0, 100_000_000) &&
    nullableRange(item.estimatedDpi, 1, 100_000) &&
    (item.estimatedDpi === null ||
      (item.unadjusted === true &&
        item.calibrationDistanceCm !== null &&
        item.calibrationCounts !== null))
  );
}
