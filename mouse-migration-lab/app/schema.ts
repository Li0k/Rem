import type { Target, TestMode } from './core';
import type { TimingModel } from './timing';

export const RUN_SCHEMA = 2 as const;
export const APP_VERSION = '0.3.0' as const;
const LEGACY_APP_VERSIONS = new Set(['0.1.0', '0.2.0']);

export type DeviceProfileSnapshot = {
  id: string;
  name: string;
  mouse: string;
  dpi: number;
  pollingRate: number;
  grip?: string;
};

export type Click = {
  t: number;
  targetId: number;
  hit: boolean;
  error: number;
  acquisition: number;
  pathEfficiency: number;
  /** Deprecated dual-v1 field: target spawn/refresh -> click. */
  responseTime?: number;
  /** dual-v2 attempt anchor -> effective movement onset -> click fields. */
  attemptAnchor?: number;
  movementOnset?: number | null;
  reactionTime?: number | null;
  movementTime?: number | null;
  completionTime?: number;
  /** Diagnostic only; never used as the primary cross-protocol metric. */
  exposureAge?: number | null;
};

export type Metrics = {
  hits: number;
  misses: number;
  accuracy: number;
  medianAcquisition: number;
  medianError: number;
  pathEfficiency: number;
  fps: number;
  p50: number;
  p95: number;
  p99: number;
  severeRatio: number;
  inputHz: number;
  longTasks: number;
  severeThreshold: number;
};

export type InputDiagnosticsSnapshot = {
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

export type RunData = {
  schema: typeof RUN_SCHEMA;
  app: 'mouse-migration-lab';
  appVersion: typeof APP_VERSION;
  createdAt: string;
  userAgent: string;
  elapsedMs: number;
  settings: {
    seed: number;
    duration: number;
    degreesPerCount: number;
    targetRadius: number;
    fov: number;
    testMode: TestMode;
    valorantSensitivity: number;
    timingModel?: TimingModel;
    gameMapping?: {
      profile: 'valorant';
      yawDegrees: number;
      source: 'community-measured' | 'custom';
    };
    inputBackend?: {
      id: string;
      native: boolean;
      unadjusted: boolean;
      dropped?: number;
      diagnostics?: InputDiagnosticsSnapshot;
    };
    device?: DeviceProfileSnapshot;
  };
  targets: Target[];
  movement: {
    t: number[];
    dx: number[];
    dy: number[];
    yaw: number[];
    pitch: number[];
    targetId: number[];
  };
  clicks: Click[];
  frames: number[];
  metrics: Metrics;
};

export const freshMetrics = (): Metrics => ({
  hits: 0,
  misses: 0,
  accuracy: 0,
  medianAcquisition: 0,
  medianError: 0,
  pathEfficiency: 0,
  fps: 0,
  p50: 0,
  p95: 0,
  p99: 0,
  severeRatio: 0,
  inputHz: 0,
  longTasks: 0,
  severeThreshold: 2 * (1000 / 60),
});

export function parseRun(value: unknown): RunData | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const settings = v.settings as Record<string, unknown> | null;
  const movement = v.movement as Record<string, unknown> | null;
  const metrics = v.metrics as Record<string, unknown> | null;
  const targets = v.targets;
  const clicks = v.clicks;
  const frames = v.frames;
  const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
  const settingDuration = settings?.duration as number;
  const settingDegreesPerCount = settings?.degreesPerCount as number;
  const settingTargetRadius = settings?.targetRadius as number;
  const settingFov = settings?.fov as number;
  const settingTestMode = settings?.testMode;
  const settingValorantSensitivity = settings?.valorantSensitivity as number;
  const timingModel = settings?.timingModel;
  const gameMapping = settings?.gameMapping as
    | Record<string, unknown>
    | undefined;
  const inputBackend = settings?.inputBackend as
    | Record<string, unknown>
    | undefined;
  const inputDiagnostics = inputBackend?.diagnostics as
    | Record<string, unknown>
    | undefined;
  const device = settings?.device as Record<string, unknown> | undefined;
  const elapsedMs = v.elapsedMs as number;
  const finiteArray = (items: unknown, max: number) =>
    Array.isArray(items) && items.length <= max && items.every(finite);
  const nonNegativeInteger = (value: unknown) =>
    finite(value) && Number.isSafeInteger(value) && (value as number) >= 0;
  const nullableNonNegative = (value: unknown) =>
    value === null || (finite(value) && (value as number) >= 0);
  const validDiagnostics =
    inputDiagnostics === undefined ||
    (typeof inputDiagnostics.backend === 'string' &&
      inputDiagnostics.backend.length > 0 &&
      inputDiagnostics.backend.length <= 128 &&
      typeof inputDiagnostics.native === 'boolean' &&
      typeof inputDiagnostics.unadjusted === 'boolean' &&
      (inputDiagnostics.fallbackReason === null ||
        (typeof inputDiagnostics.fallbackReason === 'string' &&
          inputDiagnostics.fallbackReason.length > 0 &&
          inputDiagnostics.fallbackReason.length <= 512)) &&
      typeof inputDiagnostics.registered === 'boolean' &&
      [
        'capacity',
        'packetCount',
        'eventCount',
        'movementPackets',
        'buttonEvents',
        'deviceCount',
        'peakPending',
        'currentPending',
        'dropped',
      ].every((key) => nonNegativeInteger(inputDiagnostics[key])) &&
      ['firstPacketMs', 'lastPacketMs', 'firstEventMs', 'lastEventMs'].every(
        (key) => nullableNonNegative(inputDiagnostics[key]),
      ) &&
      (inputDiagnostics.packetHz === null ||
        (finite(inputDiagnostics.packetHz) &&
          (inputDiagnostics.packetHz as number) >= 0 &&
          (inputDiagnostics.packetHz as number) <= 100_000)) &&
      (inputDiagnostics.deviceCount as number) <=
        (inputDiagnostics.packetCount as number) &&
      (inputDiagnostics.movementPackets as number) <=
        (inputDiagnostics.packetCount as number) &&
      (inputDiagnostics.eventCount as number) +
        (inputDiagnostics.dropped as number) ===
        (inputDiagnostics.movementPackets as number) +
          (inputDiagnostics.buttonEvents as number) &&
      (inputDiagnostics.currentPending as number) <=
        (inputDiagnostics.peakPending as number) &&
      ((inputDiagnostics.capacity as number) === 0 ||
        (inputDiagnostics.peakPending as number) <=
          (inputDiagnostics.capacity as number)) &&
      (inputDiagnostics.capacity as number) <= 1_000_000 &&
      ((inputDiagnostics.packetCount as number) === 0
        ? inputDiagnostics.firstPacketMs === null
        : inputDiagnostics.firstPacketMs !== null) &&
      ((inputDiagnostics.eventCount as number) +
        (inputDiagnostics.dropped as number) ===
      0
        ? inputDiagnostics.firstEventMs === null
        : inputDiagnostics.firstEventMs !== null) &&
      (inputDiagnostics.firstPacketMs === null) ===
        (inputDiagnostics.lastPacketMs === null) &&
      (inputDiagnostics.firstEventMs === null) ===
        (inputDiagnostics.lastEventMs === null) &&
      (inputDiagnostics.firstPacketMs === null ||
        (inputDiagnostics.firstPacketMs as number) <=
          (inputDiagnostics.lastPacketMs as number)) &&
      (inputDiagnostics.firstEventMs === null ||
        (inputDiagnostics.firstEventMs as number) <=
          (inputDiagnostics.lastEventMs as number)) &&
      (!inputBackend ||
        (inputDiagnostics.backend === inputBackend.id &&
          inputDiagnostics.native === inputBackend.native &&
          inputDiagnostics.unadjusted === inputBackend.unadjusted &&
          (inputBackend.dropped === undefined ||
            inputDiagnostics.dropped === inputBackend.dropped))) &&
      (inputDiagnostics.native
        ? inputDiagnostics.registered === true &&
          (inputDiagnostics.capacity as number) > 0 &&
          inputDiagnostics.fallbackReason === null
        : inputDiagnostics.registered === false &&
          (inputDiagnostics.capacity as number) === 0));
  if (
    v.schema !== RUN_SCHEMA ||
    v.app !== 'mouse-migration-lab' ||
    (v.appVersion !== APP_VERSION &&
      !LEGACY_APP_VERSIONS.has(String(v.appVersion))) ||
    typeof v.createdAt !== 'string' ||
    typeof v.userAgent !== 'string' ||
    !finite(elapsedMs) ||
    elapsedMs < 0 ||
    !settings ||
    !movement ||
    !metrics ||
    !Array.isArray(targets) ||
    !Array.isArray(clicks) ||
    !Array.isArray(frames) ||
    !finite(settings.seed) ||
    !finite(settings.duration) ||
    settingDuration < 5 ||
    settingDuration > 120 ||
    !finite(settings.degreesPerCount) ||
    settingDegreesPerCount <= 0 ||
    settingDegreesPerCount > 2 ||
    !finite(settings.targetRadius) ||
    settingTargetRadius <= 0 ||
    settingTargetRadius > 5 ||
    !finite(settings.fov) ||
    settingFov <= 30 ||
    settingFov >= 180 ||
    ![
      'four',
      'tracking',
      'three',
      'single',
      'reflex',
      'micro',
      'hold',
    ].includes(String(settingTestMode)) ||
    !finite(settingValorantSensitivity) ||
    settingValorantSensitivity <= 0 ||
    settingValorantSensitivity > 10 ||
    (timingModel !== undefined &&
      timingModel !== 'legacy-response' &&
      timingModel !== 'dual-v1' &&
      timingModel !== 'dual-v2') ||
    (gameMapping !== undefined &&
      (!gameMapping ||
        gameMapping.profile !== 'valorant' ||
        !finite(gameMapping.yawDegrees) ||
        (gameMapping.yawDegrees as number) < 0.001 ||
        (gameMapping.yawDegrees as number) > 1 ||
        (gameMapping.source !== 'community-measured' &&
          gameMapping.source !== 'custom'))) ||
    (inputBackend !== undefined &&
      (!inputBackend ||
        typeof inputBackend.id !== 'string' ||
        typeof inputBackend.native !== 'boolean' ||
        typeof inputBackend.unadjusted !== 'boolean' ||
        (inputBackend.dropped !== undefined &&
          (!finite(inputBackend.dropped) ||
            (inputBackend.dropped as number) < 0 ||
            !Number.isInteger(inputBackend.dropped))) ||
        !validDiagnostics)) ||
    (device !== undefined &&
      (!device ||
        typeof device.id !== 'string' ||
        typeof device.name !== 'string' ||
        typeof device.mouse !== 'string' ||
        !finite(device.dpi) ||
        (device.dpi as number) <= 0 ||
        !finite(device.pollingRate) ||
        (device.pollingRate as number) <= 0 ||
        (device.grip !== undefined && typeof device.grip !== 'string')))
  )
    return null;
  if (elapsedMs > settingDuration * 1000 + 1000) return null;
  if (targets.length === 0 || targets.length > 960_000) return null;
  let previousTargetSpawn = 0;
  for (let i = 0; i < targets.length; i += 1) {
    const target = targets[i] as Record<string, unknown> | null;
    if (
      !target ||
      target.id !== i ||
      !finite(target.spawn) ||
      !finite(target.yaw) ||
      !finite(target.pitch) ||
      !finite(target.radius) ||
      !finite(target.idealDistance) ||
      (target.behavior !== undefined &&
        target.behavior !== 'tracking' &&
        target.behavior !== 'hold') ||
      (target.phase !== undefined && !finite(target.phase)) ||
      (target.direction !== undefined &&
        target.direction !== -1 &&
        target.direction !== 1) ||
      (target.speed !== undefined &&
        (!finite(target.speed) || (target.speed as number) <= 0)) ||
      (target.distance !== undefined && !finite(target.distance)) ||
      (target.despawn !== undefined && !finite(target.despawn)) ||
      (target.revealAt !== undefined && !finite(target.revealAt)) ||
      (target.radius as number) <= 0 ||
      (target.radius as number) > 5 ||
      (target.distance !== undefined && (target.distance as number) <= 0) ||
      (target.idealDistance as number) < 0
    )
      return null;
    if (
      (target.spawn as number) < previousTargetSpawn ||
      (target.spawn as number) > elapsedMs + 1000
    )
      return null;
    if (
      target.despawn !== undefined &&
      ((target.despawn as number) < (target.spawn as number) ||
        (target.despawn as number) > elapsedMs + 1000)
    )
      return null;
    if (
      target.revealAt !== undefined &&
      ((target.revealAt as number) < (target.spawn as number) ||
        (target.despawn !== undefined &&
          (target.revealAt as number) > (target.despawn as number) + 1) ||
        (target.revealAt as number) > elapsedMs + 1000)
    )
      return null;
    previousTargetSpawn = target.spawn as number;
  }
  const movementKeys = ['t', 'dx', 'dy', 'yaw', 'pitch', 'targetId'];
  const movementLength = Array.isArray(movement.t) ? movement.t.length : -1;
  if (
    movementLength < 0 ||
    movementLength > settingDuration * 8000 + 1 ||
    !movementKeys.every((key) => {
      const items = movement[key];
      return Array.isArray(items) && items.length === movementLength;
    }) ||
    !finiteArray(movement.t, movementLength) ||
    !finiteArray(movement.dx, movementLength) ||
    !finiteArray(movement.dy, movementLength) ||
    !finiteArray(movement.yaw, movementLength) ||
    !finiteArray(movement.pitch, movementLength) ||
    !finiteArray(movement.targetId, movementLength)
  )
    return null;
  if (!finiteArray(frames, settingDuration * 1000 + 60)) return null;
  if (frames.some((frame) => frame <= 0)) return null;
  if ((frames as number[]).some((frame) => frame > elapsedMs + 1000))
    return null;
  if (movementLength > 0 && (movement.t as number[])[0] < 0) return null;
  if (movementLength > 0 && (movement.t as number[])[0] > elapsedMs + 1000)
    return null;
  for (let i = 1; i < movementLength; i += 1) {
    if (
      (movement.t as number[])[i] < (movement.t as number[])[i - 1] ||
      (movement.t as number[])[i] > elapsedMs + 1000
    )
      return null;
  }
  for (const id of movement.targetId as number[])
    if (!Number.isInteger(id) || id < -1 || id >= targets.length) return null;
  let previousClickTime = 0;
  for (let i = 0; i < clicks.length; i += 1) {
    const item = clicks[i] as Record<string, unknown> | null;
    if (
      !item ||
      !Number.isInteger(item.targetId) ||
      (item.targetId as number) < -1 ||
      (item.targetId as number) >= targets.length ||
      !finite(item.t) ||
      !finite(item.error) ||
      !finite(item.acquisition) ||
      !finite(item.pathEfficiency) ||
      (item.responseTime !== undefined &&
        (!finite(item.responseTime) || (item.responseTime as number) < 0)) ||
      (item.attemptAnchor !== undefined &&
        (!finite(item.attemptAnchor) || (item.attemptAnchor as number) < 0)) ||
      (item.movementOnset !== undefined &&
        !nullableNonNegative(item.movementOnset)) ||
      (item.reactionTime !== undefined &&
        !nullableNonNegative(item.reactionTime)) ||
      (item.movementTime !== undefined &&
        !nullableNonNegative(item.movementTime)) ||
      (item.completionTime !== undefined &&
        (!finite(item.completionTime) ||
          (item.completionTime as number) < 0)) ||
      (item.exposureAge !== undefined &&
        !nullableNonNegative(item.exposureAge)) ||
      (item.attemptAnchor !== undefined &&
        (item.attemptAnchor as number) > (item.t as number) + 1) ||
      (item.movementOnset !== undefined &&
        item.movementOnset !== null &&
        ((item.movementOnset as number) <
          ((item.attemptAnchor as number) ?? 0) ||
          (item.movementOnset as number) > (item.t as number) + 1)) ||
      (item.reactionTime !== undefined &&
        item.reactionTime !== null &&
        item.movementTime !== undefined &&
        item.movementTime !== null &&
        item.completionTime !== undefined &&
        Math.abs(
          (item.reactionTime as number) +
            (item.movementTime as number) -
            (item.completionTime as number),
        ) > 2) ||
      (item.error as number) < 0 ||
      (item.acquisition as number) < 0 ||
      (item.pathEfficiency as number) < 0 ||
      typeof item.hit !== 'boolean'
    )
      return null;
    if (
      (item.t as number) < previousClickTime ||
      (item.t as number) > elapsedMs + 1000
    )
      return null;
    previousClickTime = item.t as number;
    if (item.targetId !== -1) {
      const target = targets[item.targetId as number] as Record<
        string,
        unknown
      >;
      const spawn = target.spawn as number;
      const despawn = target.despawn as number | undefined;
      if (
        (item.t as number) < spawn ||
        (despawn !== undefined && (item.t as number) > despawn + 1)
      )
        return null;
    }
    if (timingModel === 'dual-v2' && item.responseTime !== undefined)
      return null;
    if (timingModel === 'dual-v2' && item.targetId !== -1 && item.hit) {
      const anchor = item.attemptAnchor as number | undefined;
      const completion = item.completionTime as number | undefined;
      const reaction = item.reactionTime as number | null | undefined;
      const movement = item.movementTime as number | null | undefined;
      if (anchor === undefined || completion === undefined) return null;
      if (Math.abs(completion - ((item.t as number) - anchor)) > 2) return null;
      if (
        reaction === undefined ||
        movement === undefined ||
        (reaction === null) !== (movement === null)
      )
        return null;
      if (reaction === null && item.movementOnset !== null) return null;
      if (
        reaction !== null &&
        (item.movementOnset === null || item.movementOnset === undefined)
      )
        return null;
      if (reaction !== null && movement !== null) {
        if (reaction > completion + 2 || movement > completion + 2) return null;
        if (Math.abs(reaction + movement - completion) > 2) return null;
      }
    }
  }
  const metricKeys = Object.keys(freshMetrics()) as (keyof Metrics)[];
  if (
    !metricKeys.every((key) => finite(metrics[key])) ||
    (metrics.accuracy as number) < 0 ||
    (metrics.accuracy as number) > 1 ||
    (metrics.severeRatio as number) < 0 ||
    (metrics.severeRatio as number) > 1 ||
    (metrics.severeThreshold as number) <= 0 ||
    (metrics.longTasks as number) < 0 ||
    !Number.isInteger(metrics.longTasks)
  )
    return null;
  // Keep schema-2 runs from earlier app builds importable. Re-saving updates
  // only appVersion; the measurement payload is left untouched.
  if (LEGACY_APP_VERSIONS.has(String(v.appVersion)))
    return { ...(value as RunData), appVersion: APP_VERSION };
  return value as RunData;
}
