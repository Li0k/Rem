import { describe, expect, it } from 'vitest';
import {
  assessComparison,
  assessRun,
  ASSESSMENT_THRESHOLDS,
  metricVerdict,
} from '../app/assessment';
import type { Metrics, RunData } from '../app/schema';

const makeRun = (
  options: {
    sensitivity?: number;
    mode?: RunData['settings']['testMode'];
    elapsedMs?: number;
    clickSamples?: number;
    movementEvents?: number;
    metrics?: Partial<Metrics>;
  } = {},
): RunData => {
  const mode = options.mode ?? 'single';
  const clickSamples = options.clickSamples ?? 20;
  const movementEvents = options.movementEvents ?? 2;
  const clicks = Array.from({ length: clickSamples }, (_, index) => ({
    t: 100 + index * 100,
    targetId: 0,
    hit: true,
    error: 4,
    acquisition: 200,
    pathEfficiency: 1.1,
  }));
  const movement = {
    t: Array.from({ length: movementEvents }, (_, index) => index + 1),
    dx: Array.from({ length: movementEvents }, () => 1),
    dy: Array.from({ length: movementEvents }, () => 0),
    yaw: Array.from({ length: movementEvents }, (_, index) => index),
    pitch: Array.from({ length: movementEvents }, () => 0),
    targetId: Array.from({ length: movementEvents }, () => 0),
  };
  const metrics: Metrics = {
    hits: mode === 'tracking' ? 2500 : clickSamples,
    misses: mode === 'tracking' ? 2500 : 0,
    accuracy: 0.5,
    medianAcquisition: 200,
    medianError: 4,
    pathEfficiency: 1.1,
    fps: 60,
    p50: 16,
    p95: 17,
    p99: 18,
    severeRatio: 0,
    inputHz: 120,
    longTasks: 0,
    severeThreshold: 32,
    ...options.metrics,
  };
  return {
    schema: 2,
    app: 'mouse-migration-lab',
    appVersion: '0.2.0',
    createdAt: '2026-09-01T00:00:00.000Z',
    userAgent: 'assessment-test',
    elapsedMs: options.elapsedMs ?? 5_000,
    settings: {
      seed: 42,
      duration: 5,
      degreesPerCount: 0.0224,
      targetRadius: 0.72,
      fov: 103,
      testMode: mode,
      valorantSensitivity: options.sensitivity ?? 0.32,
    },
    targets: [
      { id: 0, spawn: 0, yaw: 0, pitch: 0, radius: 0.72, idealDistance: 18 },
    ],
    movement,
    clicks,
    frames: [16, 17],
    metrics,
  };
};

describe('run evidence assessment', () => {
  it('treats exact minimum boundaries as passing', () => {
    const run = makeRun({
      elapsedMs: 5_000 * ASSESSMENT_THRESHOLDS.completionRatio,
      clickSamples: ASSESSMENT_THRESHOLDS.minClickSamples,
      metrics: { severeRatio: ASSESSMENT_THRESHOLDS.maxSevereFrameRatio },
    });
    const quality = assessRun(run);
    expect(quality.completed).toBe(true);
    expect(quality.minimumQuality).toBe(true);
    expect(quality.hardInvalid).toEqual([]);
  });

  it('separates missing evidence from noisy-but-readable evidence', () => {
    const missing = assessRun(makeRun({ clickSamples: 0 }));
    expect(missing.hardInvalid).toContain('没有点击样本');
    expect(missing.minimumQuality).toBe(false);

    const noisy = assessRun(
      makeRun({
        clickSamples: ASSESSMENT_THRESHOLDS.minClickSamples,
        metrics: { severeRatio: 0.02, longTasks: 1 },
      }),
    );
    expect(noisy.hardInvalid).toEqual([]);
    expect(noisy.warnings).toHaveLength(2);
    expect(noisy.minimumQuality).toBe(false);

    const malformedTelemetry = assessRun(
      makeRun({ metrics: { severeRatio: 2, medianError: -1 } }),
    );
    expect(malformedTelemetry.hardInvalid).toContain('严重掉帧指标无效');
    expect(malformedTelemetry.hardInvalid).toContain('关键指标缺失或无效');
  });

  it('does not treat zero-hit derived metrics as better evidence', () => {
    const zeroHit = makeRun({
      metrics: {
        hits: 0,
        misses: ASSESSMENT_THRESHOLDS.minClickSamples,
        accuracy: 0,
        medianAcquisition: 0,
        pathEfficiency: 0,
      },
    });
    zeroHit.clicks = zeroHit.clicks.map((click) => ({ ...click, hit: false }));
    const quality = assessRun(zeroHit);
    expect(quality.hitSamples).toBe(0);
    expect(quality.hardInvalid).toContain(
      '没有命中样本，无法评估定位时间和路径',
    );
    expect(
      assessComparison(makeRun(), {
        ...zeroHit,
        settings: { ...zeroHit.settings, valorantSensitivity: 0.33 },
      }).recommendation,
    ).toBeNull();
  });

  it('uses effective tracking milliseconds and its exact boundary', () => {
    const run = makeRun({
      mode: 'tracking',
      clickSamples: 0,
      metrics: {
        hits: ASSESSMENT_THRESHOLDS.minTrackingEffectiveMs / 2,
        misses: ASSESSMENT_THRESHOLDS.minTrackingEffectiveMs / 2,
      },
    });
    const quality = assessRun(run);
    expect(quality.trackingEffectiveMs).toBe(
      ASSESSMENT_THRESHOLDS.minTrackingEffectiveMs,
    );
    expect(quality.minimumQuality).toBe(true);
  });
});

describe('deterministic A/B evidence verdicts', () => {
  it('honors metric directions and ignores sub-threshold changes', () => {
    expect(metricVerdict('accuracy', 0.5, 0.519).verdict).toBe('neutral');
    expect(metricVerdict('accuracy', 0.5, 0.53).verdict).toBe('improved');
    expect(metricVerdict('medianError', 4, 3.8).verdict).toBe('improved');
    expect(metricVerdict('medianAcquisition', 200, 210).verdict).toBe(
      'regressed',
    );
    expect(metricVerdict('pathEfficiency', 1, 1.03).verdict).toBe('regressed');
  });

  it('recommends only the better tested sensitivity', () => {
    const assessment = assessComparison(
      makeRun(),
      makeRun({
        sensitivity: 0.33,
        metrics: {
          accuracy: 0.53,
          medianError: 3.8,
          medianAcquisition: 180,
          pathEfficiency: 1.05,
        },
      }),
    );
    expect(assessment.overall).toBe('better');
    expect(assessment.improved).toBe(4);
    expect(assessment.regressed).toBe(0);
    expect(assessment.recommendation).toContain('0.33 sensitivity');

    const worse = assessComparison(
      makeRun(),
      makeRun({
        sensitivity: 0.33,
        metrics: {
          accuracy: 0.47,
          medianError: 4.3,
          medianAcquisition: 220,
          pathEfficiency: 1.2,
        },
      }),
    );
    expect(worse.overall).toBe('worse');
    expect(worse.recommendation).toContain('0.32 sensitivity');
  });

  it('reports mixed and inconclusive without a recommendation', () => {
    const mixed = assessComparison(
      makeRun(),
      makeRun({
        sensitivity: 0.33,
        metrics: { accuracy: 0.53, medianError: 4.2 },
      }),
    );
    expect(mixed.overall).toBe('mixed');
    expect(mixed.improved).toBe(1);
    expect(mixed.regressed).toBe(1);
    expect(mixed.recommendation).toBeNull();

    const lowQuality = assessComparison(
      makeRun(),
      makeRun({ sensitivity: 0.33, clickSamples: 1 }),
    );
    expect(lowQuality.overall).toBe('inconclusive');
    expect(lowQuality.recommendation).toBeNull();

    const sameSensitivity = assessComparison(
      makeRun(),
      makeRun({
        metrics: {
          accuracy: 0.6,
          medianError: 3,
          medianAcquisition: 150,
          pathEfficiency: 1,
        },
      }),
    );
    expect(sameSensitivity.sensitivityChanged).toBe(false);
    expect(sameSensitivity.overall).toBe('inconclusive');
    expect(sameSensitivity.recommendation).toBeNull();
  });
});
