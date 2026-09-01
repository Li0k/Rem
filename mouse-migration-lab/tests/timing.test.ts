import { describe, expect, it } from 'vitest';
import {
  deriveMovementOnset,
  deriveAttemptTiming,
  medianTiming,
  DUAL_TIMING_MODEL,
} from '../app/timing';

const trace = (items: Array<[number, number, number]>) => ({
  t: items.map(([time]) => time),
  dx: items.map(([, dx]) => dx),
  dy: items.map(([, , dy]) => dy),
});

describe('deriveMovementOnset', () => {
  it('finds the first sample after a stationary period', () => {
    expect(
      deriveMovementOnset(
        trace([
          [20, 0, 0],
          [40, 0.01, 0],
          [100, 0, 0],
          [160, 1, 0],
          [180, 1, 0],
        ]),
        220,
        0,
        { degreesPerCount: 1 },
      ),
    ).toBe(160);
  });

  it('backtracks through a continuous purposeful burst', () => {
    expect(
      deriveMovementOnset(
        trace([
          [100, 0.5, 0],
          [110, 0.5, 0],
          [120, 0.5, 0],
          [130, 0.5, 0],
        ]),
        150,
        0,
        { degreesPerCount: 1 },
      ),
    ).toBe(100);
  });

  it('ignores micro-jitter and returns no false onset', () => {
    expect(
      deriveMovementOnset(
        trace([
          [100, 0.02, 0.01],
          [110, -0.03, 0.01],
          [120, 0.01, -0.02],
        ]),
        160,
        0,
        { degreesPerCount: 1, deadbandDegrees: 0.08 },
      ),
    ).toBeNull();
  });

  it('does not use evidence from before the current attempt', () => {
    expect(
      deriveMovementOnset(
        trace([
          [100, 1, 0],
          [110, 1, 0],
          [300, 0, 0],
        ]),
        320,
        200,
        { degreesPerCount: 1 },
      ),
    ).toBeNull();
  });
});

it('summarizes only measured hit timings', () => {
  expect(
    medianTiming(
      [
        {
          t: 1,
          targetId: 0,
          hit: true,
          error: 0,
          acquisition: 10,
          pathEfficiency: 1,
          reactionTime: 6,
          movementTime: 4,
          completionTime: 10,
        },
        {
          t: 2,
          targetId: 0,
          hit: false,
          error: 2,
          acquisition: 20,
          pathEfficiency: 0,
        },
        {
          t: 3,
          targetId: 0,
          hit: true,
          error: 0,
          acquisition: 30,
          pathEfficiency: 1,
          reactionTime: null,
          movementTime: null,
          completionTime: 30,
        },
      ],
      'completionTime',
    ),
  ).toBe(20);
  expect(DUAL_TIMING_MODEL).toBe('dual-v2');
});

it('keeps reaction plus movement equal to attempt completion', () => {
  const timing = deriveAttemptTiming(
    trace([
      [40, 0.2, 0],
      [50, 0.2, 0],
      [60, 0.2, 0],
    ]),
    20,
    80,
    0,
    { degreesPerCount: 1 },
  );
  expect(timing.reactionTime).toBe(20);
  expect(timing.movementTime).toBe(40);
  expect(timing.completionTime).toBe(60);
  expect(timing.reactionTime! + timing.movementTime!).toBe(
    timing.completionTime,
  );
  expect(timing.exposureAge).toBe(80);
});

it('supports multi-target round anchors and hold reveal cues', () => {
  const traceData = trace([
    [110, 0.2, 0],
    [120, 0.2, 0],
    [130, 0.2, 0],
  ]);
  const nextTarget = deriveAttemptTiming(traceData, 100, 150, 0, {
    degreesPerCount: 1,
  });
  expect(nextTarget.anchorTime).toBe(100);
  expect(nextTarget.reactionTime).toBe(10);
  expect(nextTarget.movementTime).toBe(40);
  expect(nextTarget.completionTime).toBe(50);

  const revealCue = deriveAttemptTiming(traceData, 240, 290, 0, {
    degreesPerCount: 1,
  });
  expect(revealCue.anchorTime).toBe(240);
  expect(revealCue.reactionTime).toBeNull();
  expect(revealCue.movementTime).toBeNull();
  expect(revealCue.completionTime).toBe(50);
});
