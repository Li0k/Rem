import type { DeviceMeasurement } from './device-calibration';

export type Target = {
  id: number;
  spawn: number;
  despawn?: number;
  revealAt?: number;
  yaw: number;
  pitch: number;
  radius: number;
  distance?: number;
  idealDistance: number;
  behavior?: 'tracking' | 'hold';
  phase?: number;
  direction?: number;
  speed?: number;
};

export type TestMode =
  | 'four'
  | 'tracking'
  | 'three'
  | 'single'
  | 'reflex'
  | 'micro'
  | 'hold';

export type TestProtocol = {
  id: TestMode;
  name: string;
  short: string;
  description: string;
  targetCount: number;
  radius: number;
  moving: boolean;
};

export type DeviceProfile = {
  id: string;
  name: string;
  mouse: string;
  dpi: number;
  pollingRate: number;
  grip?: string;
  game: string;
  sensitivity: number;
  yawDegrees?: number;
  mappingSource?: 'community-measured' | 'custom';
  fov: number;
  measurement?: DeviceMeasurement;
  createdAt: string;
  updatedAt: string;
};

export type ComparisonInput = {
  testMode: TestMode;
  duration: number;
  fov: number;
  seed: number;
  timingModel?: 'legacy-response' | 'dual-v1' | 'dual-v2';
};

export const VALORANT_YAW_DEGREES = 0.07;

export const TEST_PROTOCOLS: TestProtocol[] = [
  {
    id: 'four',
    name: '四目标',
    short: '微调 · 首发精度',
    description: '四个中型固定目标，命中后在固定训练墙内刷新。',
    targetCount: 4,
    radius: 1.55,
    moving: false,
  },
  {
    id: 'tracking',
    name: '人物跟枪',
    short: '横移 · 持续追踪',
    description: '按住左键持续跟随横向移动目标。',
    targetCount: 1,
    radius: 1.75,
    moving: true,
  },
  {
    id: 'three',
    name: '三目标',
    short: '小目标 · 大范围',
    description: '三个远距离小目标，练习大角度转火。',
    targetCount: 3,
    radius: 0.48,
    moving: false,
  },
  {
    id: 'single',
    name: '单球连击',
    short: '命中刷新 · 连续定位',
    description: '一个小目标，命中后立即在固定世界范围内刷新。',
    targetCount: 1,
    radius: 0.72,
    moving: false,
  },
  {
    id: 'reflex',
    name: '反应单球',
    short: '随机延迟 · 反应击杀',
    description: '目标经过随机等待后出现，记录出现到命中的时间。',
    targetCount: 1,
    radius: 0.68,
    moving: false,
  },
  {
    id: 'micro',
    name: '微调训练',
    short: '小房间 · 水平微移',
    description: '三个靠近中心的小目标，隔离低幅度修正能力。',
    targetCount: 3,
    radius: 0.58,
    moving: false,
  },
  {
    id: 'hold',
    name: '架枪训练',
    short: '墙后横拉 · 头部一枪',
    description: '移动目标从掩体开口横拉，命中后改变方向与距离。',
    targetCount: 1,
    radius: 0.62,
    moving: true,
  },
];

export function degreesPerCount(
  gameSensitivity: number,
  yawDegrees = VALORANT_YAW_DEGREES,
) {
  return gameSensitivity * yawDegrees;
}

export function protocolFor(mode: TestMode) {
  return TEST_PROTOCOLS.find((protocol) => protocol.id === mode)!;
}

export function comparisonCompatibility(
  a: ComparisonInput,
  b: ComparisonInput,
) {
  const reasons: string[] = [];
  if (a.testMode !== b.testMode) reasons.push('协议不同');
  if (a.duration !== b.duration) reasons.push('时长不同');
  if (Math.abs(a.fov - b.fov) > 0.001) reasons.push('H-FOV 不同');
  if (a.seed !== b.seed) reasons.push('Seed 不同');
  const timingA = a.timingModel ?? 'legacy-response';
  const timingB = b.timingModel ?? 'legacy-response';
  if (timingA !== timingB) reasons.push('计时语义不同');
  return { compatible: reasons.length === 0, reasons };
}

export function comparisonDeltas(
  base: {
    accuracy: number;
    medianError: number;
    medianAcquisition: number;
    pathEfficiency: number;
  },
  candidate: {
    accuracy: number;
    medianError: number;
    medianAcquisition: number;
    pathEfficiency: number;
  },
) {
  const delta = (a: number, b: number) => (a === 0 ? 0 : (b - a) / Math.abs(a));
  return {
    accuracy: candidate.accuracy - base.accuracy,
    medianError: candidate.medianError - base.medianError,
    medianAcquisition: candidate.medianAcquisition - base.medianAcquisition,
    pathEfficiency: candidate.pathEfficiency - base.pathEfficiency,
    accuracyPct: delta(base.accuracy, candidate.accuracy),
    medianErrorPct: delta(base.medianError, candidate.medianError),
    medianAcquisitionPct: delta(
      base.medianAcquisition,
      candidate.medianAcquisition,
    ),
    pathEfficiencyPct: delta(base.pathEfficiency, candidate.pathEfficiency),
  };
}

export function deltaImprovesMetric(
  metric: 'accuracy' | 'medianError' | 'medianAcquisition' | 'pathEfficiency',
  delta: number,
) {
  // Accuracy benefits from growth; errors, time, and path multipliers do not.
  return metric === 'accuracy' ? delta > 0 : delta < 0;
}

export function mulberry32(seed: number) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export function wrapDegrees(value: number) {
  return ((((value + 180) % 360) + 360) % 360) - 180;
}

export function angularDistance(
  yaw: number,
  pitch: number,
  targetYaw: number,
  targetPitch: number,
) {
  return Math.hypot(wrapDegrees(targetYaw - yaw), targetPitch - pitch);
}

export function sphericalAngularDistance(
  yaw: number,
  pitch: number,
  targetYaw: number,
  targetPitch: number,
) {
  const toRadians = Math.PI / 180;
  const yawA = yaw * toRadians;
  const pitchA = pitch * toRadians;
  const yawB = targetYaw * toRadians;
  const pitchB = targetPitch * toRadians;
  const dot =
    Math.sin(pitchA) * Math.sin(pitchB) +
    Math.cos(pitchA) * Math.cos(pitchB) * Math.cos(yawA - yawB);
  if (dot >= 1 - 1e-12) return 0;
  return (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
}

export function anglesToWorld(
  yaw: number,
  pitch: number,
  distance: number,
  out: Float32Array,
) {
  const toRadians = Math.PI / 180;
  const yawRadians = yaw * toRadians;
  const pitchRadians = pitch * toRadians;
  const horizontal = Math.cos(pitchRadians) * distance;
  out[0] = -Math.sin(yawRadians) * horizontal;
  out[1] = Math.sin(pitchRadians) * distance;
  out[2] = -Math.cos(yawRadians) * horizontal;
  return out;
}

export function projectWorldYXZ(
  worldX: number,
  worldY: number,
  worldZ: number,
  cameraYaw: number,
  cameraPitch: number,
  horizontalFov: number,
  aspect: number,
  out: Float32Array,
) {
  const toRadians = Math.PI / 180;
  const yaw = cameraYaw * toRadians;
  const pitch = cameraPitch * toRadians;
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  const cosPitch = Math.cos(pitch);
  const sinPitch = Math.sin(pitch);

  // Inverse of a Three.js camera Euler rotation ordered YXZ.
  const localX = cosYaw * worldX - sinYaw * worldZ;
  const yawedZ = sinYaw * worldX + cosYaw * worldZ;
  const localY = cosPitch * worldY + sinPitch * yawedZ;
  const localZ = -sinPitch * worldY + cosPitch * yawedZ;
  const depth = -localZ;
  if (depth <= 0.02) return false;

  const tanHalfHorizontal = Math.tan((horizontalFov * toRadians) / 2);
  const tanHalfVertical = tanHalfHorizontal / aspect;
  out[0] = localX / depth / tanHalfHorizontal;
  out[1] = localY / depth / tanHalfVertical;
  out[2] = depth;
  return Number.isFinite(out[0] + out[1] + out[2]);
}

export function angularError(yaw: number, pitch: number, target: Target) {
  return sphericalAngularDistance(yaw, pitch, target.yaw, target.pitch);
}

export function attemptPathEfficiency(
  actualPath: number,
  anchorYaw: number,
  anchorPitch: number,
  targetYaw: number,
  targetPitch: number,
) {
  const ideal = sphericalAngularDistance(
    anchorYaw,
    anchorPitch,
    targetYaw,
    targetPitch,
  );
  return Math.max(0, actualPath) / Math.max(0.001, ideal);
}

export function applyMovingTargetState(
  target: Target,
  direction: -1 | 1,
  distance: number,
) {
  target.direction = direction;
  target.distance = distance;
  return target;
}

export type AngularTarget = Pick<Target, 'yaw' | 'pitch' | 'radius'>;

export function hasAngularClearance(
  candidate: AngularTarget,
  occupied: AngularTarget[],
  gap = 0.4,
) {
  return occupied.every(
    (target) =>
      sphericalAngularDistance(
        candidate.yaw,
        candidate.pitch,
        target.yaw,
        target.pitch,
      ) >=
      candidate.radius + target.radius + gap,
  );
}

export type AngularBounds = {
  yaw: readonly [number, number];
  pitch: readonly [number, number];
};

/**
 * Finds a deterministic safe respawn position when random sampling misses the
 * available cells. The search is deliberately small and only runs after a
 * spawn, never in the input/render hot path.
 */
export function findAngularClearance(
  occupied: AngularTarget[],
  radius: number,
  bounds: AngularBounds,
  gap = 0.4,
) {
  const yawSteps = 72;
  const pitchSteps = 36;
  for (let pitchIndex = 0; pitchIndex <= pitchSteps; pitchIndex += 1) {
    const pitch =
      bounds.pitch[0] +
      ((bounds.pitch[1] - bounds.pitch[0]) * pitchIndex) / pitchSteps;
    for (let yawIndex = 0; yawIndex <= yawSteps; yawIndex += 1) {
      const yaw =
        bounds.yaw[0] + ((bounds.yaw[1] - bounds.yaw[0]) * yawIndex) / yawSteps;
      const candidate = { yaw, pitch, radius };
      if (hasAngularClearance(candidate, occupied, gap))
        return [yaw, pitch] as const;
    }
  }
  return null;
}

export function spawnTarget(
  id: number,
  spawn: number,
  baseYaw: number,
  basePitch: number,
  offsetYaw: number,
  offsetPitch: number,
  radius: number,
): Target {
  const yaw = baseYaw + offsetYaw;
  const pitch = Math.max(-85, Math.min(85, basePitch + offsetPitch));
  return {
    id,
    spawn,
    yaw,
    pitch,
    radius,
    idealDistance: sphericalAngularDistance(baseYaw, basePitch, yaw, pitch),
  };
}

export function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export function percentile(values: number[], p: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

export type FrameSummary = {
  p50: number;
  p95: number;
  p99: number;
  count: number;
};

export function summarizeHistogram(
  histogram: Uint32Array,
  overflow: number,
  binMs: number,
): FrameSummary {
  const count = histogram.reduce((sum, value) => sum + value, overflow);
  if (!count) return { p50: 0, p95: 0, p99: 0, count: 0 };
  const at = (p: number) => {
    const rank = Math.max(1, Math.ceil(count * p));
    let seen = 0;
    for (let i = 0; i < histogram.length; i += 1) {
      seen += histogram[i];
      if (seen >= rank) return (i + 0.5) * binMs;
    }
    return histogram.length * binMs;
  };
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), count };
}

export function countAbove(
  histogram: Uint32Array,
  threshold: number,
  binMs: number,
  overflow: number,
) {
  const firstBin = Math.max(0, Math.ceil(threshold / binMs - 0.5));
  let count = overflow;
  for (let i = firstBin; i < histogram.length; i += 1) count += histogram[i];
  return count;
}
