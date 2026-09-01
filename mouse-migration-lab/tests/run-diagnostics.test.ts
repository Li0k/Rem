import { describe, expect, it } from 'vitest';
import { diagnoseRun, RUN_DIAGNOSTIC_THRESHOLDS } from '../app/run-diagnostics';
import type { Metrics, RunData } from '../app/schema';

const metrics: Metrics = {
  hits: 1,
  misses: 0,
  accuracy: 1,
  medianAcquisition: 200,
  medianError: 0,
  pathEfficiency: 1,
  fps: 60,
  p50: 16,
  p95: 17,
  p99: 18,
  severeRatio: 0,
  inputHz: 120,
  longTasks: 0,
  severeThreshold: 32,
};

const makeRun = (
  options: {
    mode?: RunData['settings']['testMode'];
    target?: Partial<RunData['targets'][number]>;
    movement?: Partial<RunData['movement']>;
    click?: Partial<RunData['clicks'][number]>;
  } = {},
): RunData => {
  const target = {
    id: 0,
    spawn: 0,
    yaw: 10,
    pitch: 0,
    radius: 1,
    idealDistance: 10,
    ...options.target,
  };
  const movement = {
    t: [50, 100, 150, 200],
    dx: [0, 0, 0, 0],
    dy: [0, 0, 0, 0],
    yaw: [2, 5, 9.5, 10],
    pitch: [0, 0, 0, 0],
    targetId: [0, 0, 0, 0],
    ...options.movement,
  };
  const click = {
    t: 220,
    targetId: 0,
    hit: true,
    error: 0,
    acquisition: 220,
    pathEfficiency: 1,
    ...options.click,
  };
  return {
    schema: 2,
    app: 'mouse-migration-lab',
    appVersion: '0.3.0',
    createdAt: '2026-09-01T00:00:00.000Z',
    userAgent: 'diagnostics-test',
    elapsedMs: 5_000,
    settings: {
      seed: 1,
      duration: 5,
      degreesPerCount: 0.0224,
      targetRadius: 1,
      fov: 103,
      testMode: options.mode ?? 'single',
      valorantSensitivity: 0.32,
    },
    targets: [target],
    movement,
    clicks: [click],
    frames: [16, 17],
    metrics,
  };
};

describe('single-run trajectory diagnostics', () => {
  it('finds first arrival, no correction, and a short pre-click pause', () => {
    const result = diagnoseRun(makeRun());

    expect(result.status).toBe('available');
    expect(result.analyzedAttempts).toBe(1);
    expect(result.arrival.medianMs).toBe(150);
    expect(result.pause.medianMs).toBe(20);
    expect(result.corrections.median).toBe(0);
    expect(result.overshoot.count).toBe(0);
    expect(result.undershoot.count).toBe(0);
    expect(result.highlights[0]?.verdict).toBe('inside');
  });

  it('classifies a clear undershoot at the click endpoint', () => {
    const result = diagnoseRun(
      makeRun({
        movement: {
          t: [50, 100, 150],
          yaw: [2, 5, 7],
          pitch: [0, 0, 0],
          dx: [0, 0, 0],
          dy: [0, 0, 0],
          targetId: [0, 0, 0],
        },
        click: { t: 200, hit: false, error: 3 },
      }),
    );

    expect(result.undershoot.count).toBe(1);
    expect(result.undershoot.median).toBeCloseTo(1.8);
    expect(result.highlights[0]?.verdict).toBe('under');
  });

  it('classifies overshoot and counts a meaningful reversal', () => {
    const result = diagnoseRun(
      makeRun({
        movement: {
          t: [50, 100, 150, 200],
          yaw: [5, 11.5, 12, 10],
          pitch: [0, 0, 0, 0],
          dx: [0, 0, 0, 0],
          dy: [0, 0, 0, 0],
          targetId: [0, 0, 0, 0],
        },
      }),
    );

    expect(result.overshoot.count).toBe(1);
    expect(result.overshoot.median).toBeCloseTo(0.8);
    expect(result.corrections.median).toBe(1);
    expect(result.highlights[0]?.verdict).toBe('over');
  });

  it('starts a fresh trajectory segment after a miss on the same target', () => {
    const run = makeRun({
      target: { despawn: 220 },
      movement: {
        t: [50, 100, 150, 200],
        yaw: [2, 5, 7, 10],
        pitch: [0, 0, 0, 0],
        dx: [0, 0, 0, 0],
        dy: [0, 0, 0, 0],
        targetId: [0, 0, 0, 0],
      },
      click: { t: 120, hit: false, error: 5 },
    });
    run.clicks.push({
      t: 220,
      targetId: 0,
      hit: true,
      error: 0,
      acquisition: 220,
      pathEfficiency: 1,
    });

    const result = diagnoseRun(run);
    expect(result.analyzedAttempts).toBe(2);
    expect(result.undershoot.count).toBe(1);
    expect(result.arrival.medianMs).toBe(80);
    expect(result.corrections.p75).toBe(0);
  });

  it('ignores sub-deadband jitter as a correction', () => {
    const result = diagnoseRun(
      makeRun({
        movement: {
          t: [50, 100, 150, 200],
          yaw: [1, 1.1, 1.05, 2],
          pitch: [0, 0, 0, 0],
          dx: [0, 0, 0, 0],
          dy: [0, 0, 0, 0],
          targetId: [0, 0, 0, 0],
        },
      }),
    );

    expect(RUN_DIAGNOSTIC_THRESHOLDS.movementDeadbandDeg).toBe(0.15);
    expect(result.corrections.median).toBe(0);
  });

  it('does not mistake lateral error for undershoot', () => {
    const result = diagnoseRun(
      makeRun({
        target: { yaw: 10, pitch: 5, radius: 1 },
        movement: {
          t: [100],
          yaw: [10],
          pitch: [0],
          dx: [0],
          dy: [0],
          targetId: [0],
        },
        click: { t: 150, hit: false, error: 5 },
      }),
    );

    expect(result.undershoot.count).toBe(0);
    expect(result.highlights[0]?.verdict).toBe('lateral');
  });

  it('handles yaw wrap across the -180/180 seam', () => {
    const result = diagnoseRun(
      makeRun({
        target: { spawn: 100, yaw: 179 },
        movement: {
          t: [50, 150],
          yaw: [-179, 179],
          pitch: [0, 0],
          dx: [0, 0],
          dy: [0, 0],
          targetId: [0, 0],
        },
        click: { t: 200, hit: true, error: 0 },
      }),
    );

    expect(result.status).toBe('available');
    expect(result.overshoot.count).toBe(0);
    expect(result.undershoot.count).toBe(0);
    expect(result.highlights[0]?.verdict).toBe('inside');
  });

  it('keeps tracking not-applicable and hold limited', () => {
    const tracking = diagnoseRun(makeRun({ mode: 'tracking' }));
    expect(tracking.status).toBe('not-applicable');
    expect(tracking.scope).toBe('tracking');

    const hold = diagnoseRun(
      makeRun({
        mode: 'hold',
        target: { behavior: 'hold', phase: 0, direction: 1, speed: 1 },
      }),
    );
    expect(hold.status).toBe('limited');
    expect(hold.scope).toBe('moving-target');
    expect(hold.overshoot.count).toBe(0);
    expect(hold.undershoot.count).toBe(0);
  });

  it('reports insufficient evidence for an unknown target click', () => {
    const result = diagnoseRun(
      makeRun({ click: { targetId: -1, hit: false } }),
    );

    expect(result.status).toBe('insufficient');
    expect(result.analyzedAttempts).toBe(0);
    expect(result.note).toContain('目标轨迹');
  });
});
