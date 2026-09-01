import {
  sphericalAngularDistance,
  wrapDegrees,
  type TestMode,
  type Target,
} from './core';
import type { RunData } from './schema';

/**
 * These are interpretation thresholds, not claims about human performance.
 * The diagnostics run after a session has ended, so keeping these calculations
 * out of the input/render loop is intentional.
 */
export const RUN_DIAGNOSTIC_THRESHOLDS = {
  movementDeadbandDeg: 0.15,
  correctionMinTravelDeg: 0.25,
  classificationDeadbandDeg: 0.2,
  pauseMs: 120,
  maxHighlights: 6,
} as const;

export type DiagnosticVerdict =
  | 'over'
  | 'under'
  | 'lateral'
  | 'inside'
  | 'unknown';

export type DiagnosticEvidence =
  | 'static-target'
  | 'moving-target'
  | 'insufficient';

export type AttemptDiagnostic = {
  targetId: number;
  clickMs: number;
  hit: boolean;
  firstArrivalMs: number | null;
  pauseBeforeClickMs: number | null;
  correctionCount: number;
  overshootDeg: number;
  undershootDeg: number;
  verdict: DiagnosticVerdict;
  evidence: DiagnosticEvidence;
};

export type DiagnosticStats = {
  count: number;
  rate: number | null;
  median: number | null;
  p75: number | null;
};

export type RunDiagnostics = {
  status: 'available' | 'limited' | 'not-applicable' | 'insufficient';
  scope: 'static-clicks' | 'moving-target' | 'tracking' | 'insufficient';
  attempts: number;
  analyzedAttempts: number;
  overshoot: DiagnosticStats;
  undershoot: DiagnosticStats;
  corrections: {
    count: number;
    median: number | null;
    p75: number | null;
    zeroRate: number | null;
  };
  arrival: {
    sampled: number;
    medianMs: number | null;
    p75Ms: number | null;
  };
  pause: {
    sampled: number;
    medianMs: number | null;
    p75Ms: number | null;
    overThresholdRate: number | null;
  };
  highlights: AttemptDiagnostic[];
  note?: string;
};

type Pose = { yaw: number; pitch: number; visible: boolean };

type TargetState = {
  target: Target;
  moving: boolean;
  attemptStartAt: number;
  startYaw: number;
  startPitch: number;
  initialDistance: number;
  previousProgress: number;
  currentProgress: number;
  maxProgress: number;
  lastLateralError: number;
  lastDirection: -1 | 0 | 1;
  pendingDirection: -1 | 0 | 1;
  pendingTravel: number;
  pendingCounted: boolean;
  correctionCount: number;
  firstArrivalAt: number | null;
  lastMovementAt: number;
  lastDistance: number;
  lastVisible: boolean;
};

const STATIC_MODES = new Set<TestMode>([
  'four',
  'three',
  'single',
  'reflex',
  'micro',
]);

const finite = (value: number) => Number.isFinite(value);

const emptyStats = (): DiagnosticStats => ({
  count: 0,
  rate: null,
  median: null,
  p75: null,
});

const percentile = (values: number[], p: number) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
};

const stats = (values: number[], denominator: number): DiagnosticStats => ({
  count: values.length,
  rate: denominator > 0 ? values.length / denominator : null,
  median: percentile(values, 0.5),
  p75: percentile(values, 0.75),
});

const targetAt = (target: Target, timeMs: number): Pose => {
  if (target.behavior === 'tracking') {
    const seconds = timeMs / 1000;
    return {
      yaw: Math.sin(seconds * 1.65 + (target.phase ?? 0)) * 16,
      pitch:
        target.pitch +
        Math.pow(
          Math.max(0, Math.sin(seconds * 1.25 + (target.phase ?? 0))),
          10,
        ) *
          4.2,
      visible: true,
    };
  }
  if (target.behavior === 'hold') {
    const seconds = timeMs / 1000;
    const travel =
      ((seconds * (target.speed ?? 1) + (target.phase ?? 0)) % 2) - 1;
    const triangle = 1 - 2 * Math.abs(travel);
    const yaw = triangle * 15 * (target.direction ?? 1);
    return {
      yaw,
      pitch: target.pitch,
      visible: Math.abs(yaw) > 5.5,
    };
  }
  return { yaw: target.yaw, pitch: target.pitch, visible: true };
};

const createState = (
  target: Target,
  startYaw: number,
  startPitch: number,
): TargetState => {
  const pose = targetAt(target, target.spawn);
  const initialYaw = wrapDegrees(pose.yaw - startYaw);
  const initialPitch = pose.pitch - startPitch;
  const initialDistance = Math.hypot(initialYaw, initialPitch);
  return {
    target,
    moving: target.behavior !== undefined,
    attemptStartAt: target.spawn,
    startYaw,
    startPitch,
    initialDistance,
    previousProgress: 0,
    currentProgress: 0,
    maxProgress: 0,
    lastLateralError: 0,
    lastDirection: 0,
    pendingDirection: 0,
    pendingTravel: 0,
    pendingCounted: false,
    correctionCount: 0,
    firstArrivalAt: null,
    lastMovementAt: target.spawn,
    lastDistance: initialDistance,
    lastVisible: pose.visible,
  };
};

const resetAttempt = (
  state: TargetState,
  cameraYaw: number,
  cameraPitch: number,
  timeMs: number,
) => {
  const pose = targetAt(state.target, timeMs);
  state.attemptStartAt = timeMs;
  state.startYaw = cameraYaw;
  state.startPitch = cameraPitch;
  state.initialDistance = sphericalAngularDistance(
    cameraYaw,
    cameraPitch,
    pose.yaw,
    pose.pitch,
  );
  state.previousProgress = 0;
  state.currentProgress = 0;
  state.maxProgress = 0;
  state.lastLateralError = 0;
  state.lastDirection = 0;
  state.pendingDirection = 0;
  state.pendingTravel = 0;
  state.pendingCounted = false;
  state.correctionCount = 0;
  state.firstArrivalAt = null;
  state.lastMovementAt = timeMs;
  state.lastDistance = state.initialDistance;
  state.lastVisible = pose.visible;
};

const updateState = (
  state: TargetState,
  cameraYaw: number,
  cameraPitch: number,
  timeMs: number,
  movement: boolean,
) => {
  const pose = targetAt(state.target, timeMs);
  const distance = sphericalAngularDistance(
    cameraYaw,
    cameraPitch,
    pose.yaw,
    pose.pitch,
  );
  state.lastDistance = distance;
  state.lastVisible = pose.visible;
  if (movement) state.lastMovementAt = timeMs;
  if (
    state.firstArrivalAt === null &&
    pose.visible &&
    distance <= state.target.radius
  )
    state.firstArrivalAt = timeMs;

  if (state.moving || state.initialDistance < 1e-6) return;
  const cameraYawDelta = wrapDegrees(cameraYaw - state.startYaw);
  const cameraPitchDelta = cameraPitch - state.startPitch;
  const targetYaw = wrapDegrees(pose.yaw - state.startYaw);
  const targetPitch = pose.pitch - state.startPitch;
  const targetLength = Math.hypot(targetYaw, targetPitch);
  if (targetLength < 1e-6) return;
  const directionYaw = targetYaw / targetLength;
  const directionPitch = targetPitch / targetLength;
  const progress =
    cameraYawDelta * directionYaw + cameraPitchDelta * directionPitch;
  const alongError = targetLength - progress;
  const lateralYaw = targetYaw - cameraYawDelta;
  const lateralPitch = targetPitch - cameraPitchDelta;
  state.lastLateralError = Math.hypot(
    lateralYaw - directionYaw * alongError,
    lateralPitch - directionPitch * alongError,
  );
  const delta = progress - state.previousProgress;
  state.currentProgress = progress;
  state.maxProgress = Math.max(state.maxProgress, progress);
  state.previousProgress = progress;
  if (
    !movement ||
    Math.abs(delta) < RUN_DIAGNOSTIC_THRESHOLDS.movementDeadbandDeg
  )
    return;
  const direction = delta > 0 ? 1 : -1;
  if (state.lastDirection === 0) {
    state.lastDirection = direction;
    return;
  }
  if (direction !== state.lastDirection) {
    state.pendingDirection = direction;
    state.pendingTravel = Math.abs(delta);
    state.pendingCounted = false;
    state.lastDirection = direction;
  } else if (state.pendingDirection === direction) {
    state.pendingTravel += Math.abs(delta);
  }
  if (
    state.pendingDirection !== 0 &&
    !state.pendingCounted &&
    state.pendingTravel >= RUN_DIAGNOSTIC_THRESHOLDS.correctionMinTravelDeg
  ) {
    state.correctionCount += 1;
    state.pendingCounted = true;
  }
};

const emptyResult = (
  status: RunDiagnostics['status'],
  scope: RunDiagnostics['scope'],
  attempts: number,
  note: string,
): RunDiagnostics => ({
  status,
  scope,
  attempts,
  analyzedAttempts: 0,
  overshoot: emptyStats(),
  undershoot: emptyStats(),
  corrections: { count: 0, median: null, p75: null, zeroRate: null },
  arrival: { sampled: 0, medianMs: null, p75Ms: null },
  pause: { sampled: 0, medianMs: null, p75Ms: null, overThresholdRate: null },
  highlights: [],
  note,
});

/**
 * Derives human-readable single-run evidence from the immutable run payload.
 * The event merge advances movement and click cursors once, so work is linear
 * in recorded events times the small number of concurrently visible targets.
 */
export function diagnoseRun(run: RunData): RunDiagnostics {
  const mode = run.settings.testMode;
  const attempts = run.clicks.length;
  if (mode === 'tracking')
    return emptyResult(
      'not-applicable',
      'tracking',
      attempts,
      '跟枪协议没有离散点击，不适用过冲/欠冲诊断',
    );

  const staticProtocol = STATIC_MODES.has(mode);
  const movingProtocol = mode === 'hold';
  if (!staticProtocol && !movingProtocol)
    return emptyResult(
      'insufficient',
      'insufficient',
      attempts,
      '协议没有可解释的轨迹证据',
    );

  const statesById = new Map<number, TargetState>();
  const active: TargetState[] = [];
  const arrivalValues: number[] = [];
  const pauseValues: number[] = [];
  const correctionValues: number[] = [];
  const overValues: number[] = [];
  const underValues: number[] = [];
  const highlights: AttemptDiagnostic[] = [];
  let analyzedAttempts = 0;
  let movementIndex = 0;
  let targetIndex = 0;
  let clickIndex = 0;
  let cameraYaw = 0;
  let cameraPitch = 0;

  const considerHighlight = (attempt: AttemptDiagnostic) => {
    const score = Math.max(
      attempt.overshootDeg,
      attempt.undershootDeg,
      attempt.correctionCount * 0.2,
      (attempt.pauseBeforeClickMs ?? 0) / 1000,
    );
    if (highlights.length < RUN_DIAGNOSTIC_THRESHOLDS.maxHighlights) {
      highlights.push(attempt);
      return;
    }
    let smallest = 0;
    for (let index = 1; index < highlights.length; index += 1) {
      const other = highlights[index];
      const otherScore = Math.max(
        other.overshootDeg,
        other.undershootDeg,
        other.correctionCount * 0.2,
        (other.pauseBeforeClickMs ?? 0) / 1000,
      );
      const smallestScore = Math.max(
        highlights[smallest].overshootDeg,
        highlights[smallest].undershootDeg,
        highlights[smallest].correctionCount * 0.2,
        (highlights[smallest].pauseBeforeClickMs ?? 0) / 1000,
      );
      if (otherScore < smallestScore) smallest = index;
    }
    const smallestScore = Math.max(
      highlights[smallest].overshootDeg,
      highlights[smallest].undershootDeg,
      highlights[smallest].correctionCount * 0.2,
      (highlights[smallest].pauseBeforeClickMs ?? 0) / 1000,
    );
    if (score > smallestScore) highlights[smallest] = attempt;
  };

  const expire = (timeMs: number) => {
    for (let index = active.length - 1; index >= 0; index -= 1) {
      const despawn = active[index].target.despawn;
      if (despawn !== undefined && despawn < timeMs) active.splice(index, 1);
    }
  };

  const addTargets = (timeMs: number) => {
    while (
      targetIndex < run.targets.length &&
      run.targets[targetIndex].spawn <= timeMs
    ) {
      const target = run.targets[targetIndex++];
      const state = createState(target, cameraYaw, cameraPitch);
      statesById.set(target.id, state);
      if (active.length < 32) active.push(state);
    }
  };

  const updateActive = (timeMs: number, movement: boolean) => {
    expire(timeMs);
    for (const state of active)
      updateState(state, cameraYaw, cameraPitch, timeMs, movement);
  };

  const processClick = (click: RunData['clicks'][number]) => {
    const state = statesById.get(click.targetId);
    if (!state || click.t < state.target.spawn) return;
    updateState(state, cameraYaw, cameraPitch, click.t, false);
    const firstArrivalMs =
      state.firstArrivalAt === null
        ? null
        : Math.max(0, state.firstArrivalAt - state.attemptStartAt);
    const pauseBeforeClickMs =
      firstArrivalMs === null
        ? null
        : Math.max(0, click.t - state.lastMovementAt);
    if (state.moving) {
      analyzedAttempts += 1;
      if (firstArrivalMs !== null) arrivalValues.push(firstArrivalMs);
      if (pauseBeforeClickMs !== null) pauseValues.push(pauseBeforeClickMs);
      const attempt: AttemptDiagnostic = {
        targetId: click.targetId,
        clickMs: click.t,
        hit: click.hit,
        firstArrivalMs,
        pauseBeforeClickMs,
        correctionCount: 0,
        overshootDeg: 0,
        undershootDeg: 0,
        verdict:
          state.lastVisible && state.lastDistance <= state.target.radius
            ? 'inside'
            : 'unknown',
        evidence: 'moving-target',
      };
      considerHighlight(attempt);
      if (state.target.despawn === undefined || state.target.despawn > click.t)
        resetAttempt(state, cameraYaw, cameraPitch, click.t);
      return;
    }
    if (state.initialDistance < 1e-6) return;
    analyzedAttempts += 1;
    const deadband = RUN_DIAGNOSTIC_THRESHOLDS.classificationDeadbandDeg;
    const overshootDeg = Math.max(
      0,
      state.maxProgress -
        state.initialDistance -
        state.target.radius -
        deadband,
    );
    const undershootDeg = Math.max(
      0,
      state.initialDistance -
        state.target.radius -
        deadband -
        state.currentProgress,
    );
    const lateralDominant =
      state.lastLateralError >
      Math.max(
        deadband,
        Math.abs(state.initialDistance - state.currentProgress) * 0.5,
      );
    const classifiedUndershoot = lateralDominant ? 0 : undershootDeg;
    const inside =
      state.lastVisible && state.lastDistance <= state.target.radius;
    const verdict: DiagnosticVerdict = inside
      ? overshootDeg > 0
        ? 'over'
        : 'inside'
      : overshootDeg > 0
        ? 'over'
        : classifiedUndershoot > 0
          ? 'under'
          : 'lateral';
    const attempt: AttemptDiagnostic = {
      targetId: click.targetId,
      clickMs: click.t,
      hit: click.hit,
      firstArrivalMs,
      pauseBeforeClickMs,
      correctionCount: state.correctionCount,
      overshootDeg,
      undershootDeg: classifiedUndershoot,
      verdict,
      evidence: 'static-target',
    };
    correctionValues.push(state.correctionCount);
    if (firstArrivalMs !== null) arrivalValues.push(firstArrivalMs);
    if (pauseBeforeClickMs !== null) pauseValues.push(pauseBeforeClickMs);
    if (overshootDeg > 0) overValues.push(overshootDeg);
    if (classifiedUndershoot > 0 && overshootDeg === 0)
      underValues.push(classifiedUndershoot);
    considerHighlight(attempt);
    if (state.target.despawn === undefined || state.target.despawn > click.t)
      resetAttempt(state, cameraYaw, cameraPitch, click.t);
  };

  while (
    movementIndex < run.movement.t.length ||
    clickIndex < run.clicks.length
  ) {
    const movementTime =
      movementIndex < run.movement.t.length
        ? run.movement.t[movementIndex]
        : Number.POSITIVE_INFINITY;
    const clickTime =
      clickIndex < run.clicks.length
        ? run.clicks[clickIndex].t
        : Number.POSITIVE_INFINITY;
    const timeMs = Math.min(movementTime, clickTime);
    if (!finite(timeMs)) break;
    addTargets(timeMs);
    if (movementTime <= clickTime) {
      cameraYaw = run.movement.yaw[movementIndex];
      cameraPitch = run.movement.pitch[movementIndex];
      updateActive(movementTime, true);
      movementIndex += 1;
    } else {
      processClick(run.clicks[clickIndex]);
      clickIndex += 1;
    }
  }

  if (!analyzedAttempts)
    return emptyResult(
      'insufficient',
      movingProtocol ? 'moving-target' : 'insufficient',
      attempts,
      '没有足够的目标轨迹与点击对应关系',
    );

  const status = movingProtocol ? 'limited' : 'available';
  return {
    status,
    scope: movingProtocol ? 'moving-target' : 'static-clicks',
    attempts,
    analyzedAttempts,
    overshoot: movingProtocol
      ? emptyStats()
      : stats(overValues, analyzedAttempts),
    undershoot: movingProtocol
      ? emptyStats()
      : stats(underValues, analyzedAttempts),
    corrections: {
      count: correctionValues.reduce((sum, value) => sum + value, 0),
      median: movingProtocol ? null : percentile(correctionValues, 0.5),
      p75: movingProtocol ? null : percentile(correctionValues, 0.75),
      zeroRate:
        movingProtocol || !correctionValues.length
          ? null
          : correctionValues.filter((value) => value === 0).length /
            correctionValues.length,
    },
    arrival: {
      sampled: arrivalValues.length,
      medianMs: percentile(arrivalValues, 0.5),
      p75Ms: percentile(arrivalValues, 0.75),
    },
    pause: {
      sampled: pauseValues.length,
      medianMs: percentile(pauseValues, 0.5),
      p75Ms: percentile(pauseValues, 0.75),
      overThresholdRate:
        pauseValues.length > 0
          ? pauseValues.filter(
              (value) => value > RUN_DIAGNOSTIC_THRESHOLDS.pauseMs,
            ).length / pauseValues.length
          : null,
    },
    highlights: highlights.sort((a, b) => b.clickMs - a.clickMs),
    note: movingProtocol
      ? '架枪目标会移动并受掩体可见性影响，仅展示到达与停顿；不把目标运动归因成过冲或欠冲'
      : '过冲/欠冲按相对目标中心的角度投影判定；停顿是最后一次移动到点击的无输入间隔，不是反应时间',
  };
}
