import { describe, expect, it } from 'vitest';
import { parseRun } from '../app/schema';
import {
  anglesToWorld,
  angularDistance,
  angularError,
  comparisonCompatibility,
  comparisonDeltas,
  deltaImprovesMetric,
  countAbove,
  degreesPerCount,
  median,
  mulberry32,
  percentile,
  projectWorldYXZ,
  spawnTarget,
  summarizeHistogram,
  type Target,
} from '../app/core';

const validRun = () => ({
  schema: 2,
  app: 'mouse-migration-lab',
  appVersion: '0.2.0',
  createdAt: '2026-09-01T00:00:00.000Z',
  userAgent: 'fixture',
  elapsedMs: 20,
  settings: {
    seed: 1,
    duration: 5,
    degreesPerCount: 0.08,
    targetRadius: 1.2,
    fov: 90,
    testMode: 'single',
    valorantSensitivity: 0.32,
  },
  targets: [
    { id: 0, spawn: 0, yaw: 2, pitch: 1, radius: 1.2, idealDistance: 2.23 },
    { id: 1, spawn: 18, yaw: 4, pitch: 2, radius: 1.2, idealDistance: 2.23 },
  ],
  movement: {
    t: [1, 16],
    dx: [1, 1],
    dy: [0, 0],
    yaw: [1, 2],
    pitch: [0, 0],
    targetId: [0, 0],
  },
  clicks: [
    {
      t: 18,
      targetId: 0,
      hit: true,
      error: 0.4,
      acquisition: 18,
      pathEfficiency: 1.1,
    },
  ],
  frames: [16, 17],
  metrics: {
    hits: 1,
    misses: 0,
    accuracy: 1,
    medianAcquisition: 18,
    medianError: 0.4,
    pathEfficiency: 1.1,
    fps: 60,
    p50: 16,
    p95: 17,
    p99: 17,
    severeRatio: 0,
    inputHz: 120,
    longTasks: 0,
    severeThreshold: 32,
  },
});

describe('replay primitives', () => {
  it('generates the same seeded target stream every time', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect(Array.from({ length: 8 }, () => a())).toEqual(
      Array.from({ length: 8 }, () => b()),
    );
  });

  it('uses angular distance for hit evaluation', () => {
    const target: Target = {
      id: 1,
      spawn: 0,
      yaw: 3,
      pitch: 4,
      radius: 5,
      idealDistance: 5,
    };
    expect(angularError(0, 0, target)).toBeCloseTo(5, 2);
    expect(angularError(3, 4, target)).toBe(0);
    expect(angularDistance(359, 0, 1, 0)).toBe(2);
    const visible = spawnTarget(2, 0, 170, 80, 28, 15, 1.2);
    expect(visible.pitch).toBe(85);
    expect(visible.idealDistance).toBeGreaterThan(0);
  });

  it('projects targets through the same YXZ camera transform', () => {
    const world = new Float32Array(3);
    const screen = new Float32Array(3);
    anglesToWorld(23, 11, 18, world);
    expect(
      projectWorldYXZ(
        world[0],
        world[1],
        world[2],
        23,
        11,
        103,
        16 / 9,
        screen,
      ),
    ).toBe(true);
    expect(screen[0]).toBeCloseTo(0, 5);
    expect(screen[1]).toBeCloseTo(0, 5);
    expect(screen[2]).toBeCloseTo(18, 4);

    anglesToWorld(0, 0, 18, world);
    projectWorldYXZ(world[0], world[1], world[2], -10, 0, 103, 16 / 9, screen);
    expect(screen[0]).toBeLessThan(0);
  });

  it('maps Valorant sensitivity to angular counts', () => {
    expect(degreesPerCount(0.32)).toBeCloseTo(0.0224, 8);
    expect(degreesPerCount(0.32, 0.06995)).toBeCloseTo(0.022384, 8);
  });

  it('only compares runs with the same protocol contract', () => {
    const base = {
      testMode: 'single' as const,
      duration: 30,
      fov: 103,
      seed: 7,
    };
    expect(comparisonCompatibility(base, { ...base })).toEqual({
      compatible: true,
      reasons: [],
    });
    expect(
      comparisonCompatibility(base, { ...base, testMode: 'three' }),
    ).toEqual({
      compatible: false,
      reasons: ['协议不同'],
    });
  });

  it('derives directional percentage deltas without dividing by zero', () => {
    const delta = comparisonDeltas(
      {
        accuracy: 0.5,
        medianError: 4,
        medianAcquisition: 200,
        pathEfficiency: 1,
      },
      {
        accuracy: 0.6,
        medianError: 3,
        medianAcquisition: 180,
        pathEfficiency: 1.2,
      },
    );
    expect(delta.accuracyPct).toBeCloseTo(0.2);
    expect(delta.medianErrorPct).toBeCloseTo(-0.25);
    expect(delta.medianAcquisitionPct).toBeCloseTo(-0.1);
    expect(
      comparisonDeltas(
        {
          accuracy: 0,
          medianError: 0,
          medianAcquisition: 0,
          pathEfficiency: 0,
        },
        {
          accuracy: 1,
          medianError: 1,
          medianAcquisition: 1,
          pathEfficiency: 1,
        },
      ).accuracyPct,
    ).toBe(0);
    expect(deltaImprovesMetric('pathEfficiency', 0.1)).toBe(false);
    expect(deltaImprovesMetric('pathEfficiency', -0.1)).toBe(true);
  });

  it('summarizes fixed frame buckets without copying history', () => {
    const histogram = new Uint32Array(8);
    histogram[1] = 3;
    histogram[7] = 2;
    const summary = summarizeHistogram(histogram, 1, 1);
    expect(summary.count).toBe(6);
    expect(summary.p50).toBeGreaterThan(0);
    expect(countAbove(histogram, 2, 1, 1)).toBe(3);
  });

  it('keeps descriptive summaries deterministic', () => {
    expect(median([8, 2, 5])).toBe(5);
    expect(percentile([1, 2, 3, 4], 0.95)).toBe(4);
  });

  it('accepts a valid replay fixture and rejects broken contracts', () => {
    expect(parseRun(validRun())).not.toBeNull();

    const legacyVersion = validRun();
    legacyVersion.appVersion = '0.1.0';
    expect(parseRun(legacyVersion)?.appVersion).toBe('0.2.0');

    const uneven = validRun();
    uneven.movement.dy.pop();
    expect(parseRun(uneven)).toBeNull();

    const nonMonotonic = validRun();
    nonMonotonic.movement.t[1] = 0;
    expect(parseRun(nonMonotonic)).toBeNull();

    const invalidTargetOrder = validRun();
    invalidTargetOrder.clicks[0].targetId = 2;
    expect(parseRun(invalidTargetOrder)).toBeNull();

    const invalidFrame = validRun();
    invalidFrame.frames[0] = 0;
    expect(parseRun(invalidFrame)).toBeNull();

    const invalidSpawn = validRun();
    invalidSpawn.targets[1].spawn = -1;
    expect(parseRun(invalidSpawn)).toBeNull();

    const invalidMovementStart = validRun();
    invalidMovementStart.movement.t[0] = -1;
    expect(parseRun(invalidMovementStart)).toBeNull();

    const invalidDevice = validRun();
    (invalidDevice.settings as Record<string, unknown>).device = {
      id: 'bad',
      name: 'bad',
      mouse: 'bad',
      dpi: 0,
      pollingRate: 1000,
    };
    expect(parseRun(invalidDevice)).toBeNull();
  });
});
