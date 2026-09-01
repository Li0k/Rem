import { comparisonCompatibility } from './core';
import type { RunData } from './schema';

/**
 * Evidence gates are deliberately practical, not statistical confidence
 * intervals. They describe whether a run contains enough trustworthy signal
 * to put beside another run.
 */
export const ASSESSMENT_THRESHOLDS = {
  completionRatio: 0.9,
  minClickSamples: 20,
  minHitSamples: 5,
  minTrackingEffectiveMs: 5_000,
  minInputEvents: 1,
  minFrameSamples: 1,
  maxSevereFrameRatio: 0.01,
  maxLongTasks: 0,
  minSensitivityChange: 0.0001,
  metricChange: {
    accuracy: 0.02,
    medianError: 0.1,
    medianAcquisition: 10,
    pathEfficiency: 0.02,
  },
} as const;

export type EvidenceQuality = {
  completed: boolean;
  minimumQuality: boolean;
  hardInvalid: string[];
  warnings: string[];
  clickSamples: number;
  hitSamples: number;
  trackingEffectiveMs: number;
  inputEvents: number;
  inputDropped: number;
  nativePackets: number;
  inputDeviceCount: number;
  nativeInput: boolean;
  frameSamples: number;
  severeRatio: number;
  longTasks: number;
};

export type MetricKey = keyof typeof ASSESSMENT_THRESHOLDS.metricChange;
export type MetricVerdict = 'improved' | 'regressed' | 'neutral';
export type ComparisonOverall = 'better' | 'worse' | 'mixed' | 'inconclusive';

export type MetricAssessment = {
  key: MetricKey;
  label: string;
  base: number;
  candidate: number;
  delta: number;
  threshold: number;
  verdict: MetricVerdict;
};

export type ComparisonAssessment = {
  compatible: boolean;
  compatibilityReasons: string[];
  baseQuality: EvidenceQuality;
  candidateQuality: EvidenceQuality;
  sensitivityChanged: boolean;
  metrics: MetricAssessment[];
  improved: number;
  regressed: number;
  neutral: number;
  overall: ComparisonOverall;
  recommendation: string | null;
};

const METRIC_LABELS: Record<MetricKey, string> = {
  accuracy: '准确率',
  medianError: '中位角度误差',
  medianAcquisition: '中位单次完成时间',
  pathEfficiency: '路径倍率',
};

const finite = (value: number) => Number.isFinite(value);

export function assessRun(run: RunData): EvidenceQuality {
  const completed =
    finite(run.elapsedMs) &&
    finite(run.settings.duration) &&
    run.elapsedMs >=
      run.settings.duration * 1000 * ASSESSMENT_THRESHOLDS.completionRatio;
  const clickSamples = run.clicks.length;
  const hitSamples = run.clicks.filter((click) => click.hit).length;
  const trackingEffectiveMs =
    run.settings.testMode === 'tracking'
      ? Math.max(0, run.metrics.hits) + Math.max(0, run.metrics.misses)
      : 0;
  const inputEvents = run.movement.t.length;
  const inputDiagnostics = run.settings.inputBackend?.diagnostics;
  const nativeInput = run.settings.inputBackend?.native ?? false;
  const inputDropped =
    inputDiagnostics?.dropped ?? run.settings.inputBackend?.dropped ?? 0;
  const nativePackets = inputDiagnostics?.packetCount ?? 0;
  const nativeMovements = inputDiagnostics?.movementPackets ?? 0;
  const inputDeviceCount = inputDiagnostics?.deviceCount ?? 0;
  const inputPending = inputDiagnostics?.currentPending ?? 0;
  const frameSamples = run.frames.length;
  const severeRatio = run.metrics.severeRatio;
  const longTasks = run.metrics.longTasks;
  const hardInvalid: string[] = [];
  const warnings: string[] = [];

  if (!completed) hardInvalid.push('运行未完成最低时长');
  if (inputEvents < ASSESSMENT_THRESHOLDS.minInputEvents)
    hardInvalid.push('没有可验证的输入事件');
  if (!Number.isInteger(inputDropped) || inputDropped < 0)
    hardInvalid.push('原始输入丢包指标无效');
  else if (run.settings.inputBackend?.native && inputDropped > 0)
    hardInvalid.push(`原始输入缓冲丢失 ${inputDropped} 个事件`);
  if (run.settings.inputBackend?.native && nativePackets === 0)
    hardInvalid.push('WM_INPUT 未收到原始数据包');
  else if (run.settings.inputBackend?.native && nativeMovements === 0)
    hardInvalid.push('WM_INPUT 未收到鼠标移动数据');
  if (run.settings.inputBackend?.native && inputPending > 0)
    hardInvalid.push(`WM_INPUT 结束时仍有 ${inputPending} 个事件未处理`);
  if (
    run.settings.inputBackend?.native &&
    nativePackets > 0 &&
    inputDeviceCount === 0
  )
    hardInvalid.push('WM_INPUT 无法归因到物理鼠标设备');
  if (run.settings.inputBackend?.native && inputDeviceCount > 1)
    warnings.push(
      `检测到 ${inputDeviceCount} 个鼠标设备，聚合输入会污染设备归因`,
    );
  if (frameSamples < ASSESSMENT_THRESHOLDS.minFrameSamples)
    hardInvalid.push('没有可验证的帧样本');

  if (run.settings.testMode === 'tracking') {
    if (trackingEffectiveMs <= 0) hardInvalid.push('没有跟枪有效时长');
    else if (trackingEffectiveMs < ASSESSMENT_THRESHOLDS.minTrackingEffectiveMs)
      warnings.push(
        `跟枪有效时长不足 ${ASSESSMENT_THRESHOLDS.minTrackingEffectiveMs / 1000} 秒`,
      );
  } else {
    if (clickSamples === 0) hardInvalid.push('没有点击样本');
    else if (clickSamples < ASSESSMENT_THRESHOLDS.minClickSamples)
      warnings.push(`点击样本少于 ${ASSESSMENT_THRESHOLDS.minClickSamples} 次`);
    if (clickSamples > 0 && hitSamples === 0)
      hardInvalid.push('没有命中样本，无法评估单次完成时间和路径');
    else if (hitSamples < ASSESSMENT_THRESHOLDS.minHitSamples)
      warnings.push(`命中样本少于 ${ASSESSMENT_THRESHOLDS.minHitSamples} 次`);
  }

  if (!finite(severeRatio) || severeRatio < 0 || severeRatio > 1)
    hardInvalid.push('严重掉帧指标无效');
  else if (severeRatio > ASSESSMENT_THRESHOLDS.maxSevereFrameRatio)
    warnings.push(
      `严重掉帧比例 ${(severeRatio * 100).toFixed(1)}% 超过 ${ASSESSMENT_THRESHOLDS.maxSevereFrameRatio * 100}%`,
    );
  if (!Number.isInteger(longTasks) || longTasks < 0)
    hardInvalid.push('Long task 指标无效');
  else if (longTasks > ASSESSMENT_THRESHOLDS.maxLongTasks)
    warnings.push(`检测到 ${longTasks} 个 long task`);

  const metricValues = [
    run.metrics.accuracy,
    run.metrics.medianAcquisition,
    run.metrics.medianError,
    run.metrics.pathEfficiency,
    run.metrics.p50,
    run.metrics.p95,
    run.metrics.p99,
  ];
  if (
    metricValues.some((value) => !finite(value) || value < 0) ||
    run.metrics.accuracy > 1
  )
    hardInvalid.push('关键指标缺失或无效');

  return {
    completed,
    minimumQuality: hardInvalid.length === 0 && warnings.length === 0,
    hardInvalid,
    warnings,
    clickSamples,
    hitSamples,
    trackingEffectiveMs,
    inputEvents,
    inputDropped,
    nativePackets,
    inputDeviceCount,
    nativeInput,
    frameSamples,
    severeRatio,
    longTasks,
  };
}

export function metricVerdict(
  key: MetricKey,
  base: number,
  candidate: number,
): MetricAssessment {
  const delta = candidate - base;
  const threshold = ASSESSMENT_THRESHOLDS.metricChange[key];
  const meaningful =
    finite(base) && finite(candidate) && Math.abs(delta) >= threshold;
  const higherIsBetter = key === 'accuracy';
  const improved = meaningful && (higherIsBetter ? delta > 0 : delta < 0);
  const regressed = meaningful && (higherIsBetter ? delta < 0 : delta > 0);
  return {
    key,
    label: METRIC_LABELS[key],
    base,
    candidate,
    delta,
    threshold,
    verdict: improved ? 'improved' : regressed ? 'regressed' : 'neutral',
  };
}

export function assessComparison(
  base: RunData,
  candidate: RunData,
): ComparisonAssessment {
  const baseQuality = assessRun(base);
  const candidateQuality = assessRun(candidate);
  const compatibility = comparisonCompatibility(
    {
      testMode: base.settings.testMode,
      duration: base.settings.duration,
      fov: base.settings.fov,
      seed: base.settings.seed,
      timingModel: base.settings.timingModel,
    },
    {
      testMode: candidate.settings.testMode,
      duration: candidate.settings.duration,
      fov: candidate.settings.fov,
      seed: candidate.settings.seed,
      timingModel: candidate.settings.timingModel,
    },
  );
  const sensitivityChanged =
    Math.abs(
      candidate.settings.valorantSensitivity -
        base.settings.valorantSensitivity,
    ) >= ASSESSMENT_THRESHOLDS.minSensitivityChange;
  const metrics = (
    Object.keys(ASSESSMENT_THRESHOLDS.metricChange) as MetricKey[]
  ).map((key) => metricVerdict(key, base.metrics[key], candidate.metrics[key]));
  const improved = metrics.filter(
    (metric) => metric.verdict === 'improved',
  ).length;
  const regressed = metrics.filter(
    (metric) => metric.verdict === 'regressed',
  ).length;
  const neutral = metrics.length - improved - regressed;
  const enoughEvidence =
    baseQuality.minimumQuality && candidateQuality.minimumQuality;
  const overall: ComparisonOverall =
    !compatibility.compatible || !enoughEvidence || !sensitivityChanged
      ? 'inconclusive'
      : improved > 0 && regressed === 0
        ? 'better'
        : regressed > 0 && improved === 0
          ? 'worse'
          : improved > 0 && regressed > 0
            ? 'mixed'
            : 'inconclusive';
  let recommendation: string | null = null;
  if (enoughEvidence && compatibility.compatible && sensitivityChanged) {
    if (overall === 'better')
      recommendation = `当前证据更支持已测试的 ${candidate.settings.valorantSensitivity} sensitivity`;
    else if (overall === 'worse')
      recommendation = `当前证据更支持已测试的 ${base.settings.valorantSensitivity} sensitivity`;
  }
  return {
    compatible: compatibility.compatible,
    compatibilityReasons: compatibility.reasons,
    baseQuality,
    candidateQuality,
    sensitivityChanged,
    metrics,
    improved,
    regressed,
    neutral,
    overall,
    recommendation,
  };
}
