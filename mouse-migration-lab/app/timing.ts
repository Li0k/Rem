import type { Click, RunData } from './schema';

/** The legacy payload only has acquisition (spawn -> click). */
export const LEGACY_TIMING_MODEL = 'legacy-response' as const;
/** dual-v1 used target spawn age as response and is intentionally obsolete. */
export const OBSOLETE_DUAL_TIMING_MODEL = 'dual-v1' as const;
export const DUAL_TIMING_MODEL = 'dual-v2' as const;
export type TimingModel =
  | typeof LEGACY_TIMING_MODEL
  | typeof OBSOLETE_DUAL_TIMING_MODEL
  | typeof DUAL_TIMING_MODEL;

export type MovementOnsetInput = {
  t: ArrayLike<number>;
  dx: ArrayLike<number>;
  dy: ArrayLike<number>;
};

export type MovementOnsetOptions = {
  degreesPerCount: number;
  deadbandDegrees?: number;
  idleGapMs?: number;
  minEvidenceMs?: number;
};

export type AttemptTiming = {
  anchorTime: number;
  movementOnset: number | null;
  reactionTime: number | null;
  movementTime: number | null;
  completionTime: number;
  exposureAge: number | null;
};

const DEFAULT_DEADBAND_DEGREES = 0.08;
const DEFAULT_IDLE_GAP_MS = 120;
const DEFAULT_MIN_EVIDENCE_MS = 8;

/**
 * Find the start of the final purposeful movement burst before a click.
 *
 * The scan is backwards from the click and bounded by the recorded trace. A
 * sample is meaningful only when its angular displacement clears the deadband;
 * once the last meaningful sample is found, nearby meaningful samples are
 * joined across idle gaps. This deliberately returns null for jitter-only or
 * otherwise insufficient evidence instead of inventing a reaction time.
 */
export function deriveMovementOnset(
  movement: MovementOnsetInput,
  clickTimeMs: number,
  segmentStartMs: number,
  options: MovementOnsetOptions,
): number | null {
  const deadband = options.deadbandDegrees ?? DEFAULT_DEADBAND_DEGREES;
  const idleGap = options.idleGapMs ?? DEFAULT_IDLE_GAP_MS;
  const minEvidence = options.minEvidenceMs ?? DEFAULT_MIN_EVIDENCE_MS;
  if (
    !Number.isFinite(clickTimeMs) ||
    !Number.isFinite(segmentStartMs) ||
    !Number.isFinite(options.degreesPerCount) ||
    options.degreesPerCount <= 0 ||
    deadband <= 0 ||
    idleGap < 0 ||
    minEvidence < 0
  )
    return null;

  const length = Math.min(
    movement.t.length,
    movement.dx.length,
    movement.dy.length,
  );
  let lastMeaningful = -1;
  for (let index = length - 1; index >= 0; index -= 1) {
    const time = movement.t[index];
    if (time < segmentStartMs || time > clickTimeMs) continue;
    const angularDistance =
      Math.hypot(movement.dx[index], movement.dy[index]) *
      options.degreesPerCount;
    if (Number.isFinite(angularDistance) && angularDistance >= deadband) {
      lastMeaningful = index;
      break;
    }
  }
  if (lastMeaningful < 0) return null;

  let onset = lastMeaningful;
  for (let index = lastMeaningful - 1; index >= 0; index -= 1) {
    const previousTime = movement.t[index];
    const nextTime = movement.t[index + 1];
    if (previousTime < segmentStartMs || nextTime - previousTime > idleGap)
      break;
    const angularDistance =
      Math.hypot(movement.dx[index], movement.dy[index]) *
      options.degreesPerCount;
    if (!Number.isFinite(angularDistance) || angularDistance < deadband) break;
    onset = index;
  }

  const onsetTime = movement.t[onset];
  const finalTime = movement.t[lastMeaningful];
  if (
    !Number.isFinite(onsetTime) ||
    !Number.isFinite(finalTime) ||
    finalTime - onsetTime < minEvidence
  )
    return null;
  return onsetTime;
}

export function timingModelForRun(run: Pick<RunData, 'settings'>): TimingModel {
  return run.settings.timingModel === DUAL_TIMING_MODEL
    ? DUAL_TIMING_MODEL
    : run.settings.timingModel === OBSOLETE_DUAL_TIMING_MODEL
      ? OBSOLETE_DUAL_TIMING_MODEL
      : LEGACY_TIMING_MODEL;
}

export const supportsAttemptTiming = (model: TimingModel) =>
  model === DUAL_TIMING_MODEL;

export function deriveAttemptTiming(
  movement: MovementOnsetInput,
  anchorTime: number,
  clickTimeMs: number,
  targetSpawnTime: number | null,
  options: MovementOnsetOptions,
): AttemptTiming {
  const safeAnchor = Number.isFinite(anchorTime) ? Math.max(0, anchorTime) : 0;
  const completionTime = Math.max(0, clickTimeMs - safeAnchor);
  const onset = deriveMovementOnset(movement, clickTimeMs, safeAnchor, options);
  const reactionTime = onset === null ? null : Math.max(0, onset - safeAnchor);
  const movementTime = onset === null ? null : Math.max(0, clickTimeMs - onset);
  return {
    anchorTime: safeAnchor,
    movementOnset: onset,
    reactionTime,
    movementTime,
    completionTime,
    exposureAge:
      targetSpawnTime !== null && Number.isFinite(targetSpawnTime)
        ? Math.max(0, clickTimeMs - targetSpawnTime)
        : null,
  };
}

export function medianTiming(
  clicks: Click[],
  field: 'reactionTime' | 'movementTime' | 'completionTime',
): number | null {
  const values = clicks
    .filter((click) => click.hit)
    .map((click) => click[field])
    .filter(
      (value): value is number =>
        typeof value === 'number' && Number.isFinite(value),
    )
    .sort((a, b) => a - b);
  if (!values.length) return null;
  const middle = Math.floor(values.length / 2);
  return values.length % 2
    ? values[middle]
    : (values[middle - 1] + values[middle]) / 2;
}
