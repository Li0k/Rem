import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Activity,
  Check,
  ChevronRight,
  Crosshair,
  Download,
  History,
  MousePointer2,
  Plus,
  Radio,
  RotateCcw,
  Save,
  SlidersHorizontal,
  Upload,
  Zap,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import {
  comparisonCompatibility,
  comparisonDeltas,
  countAbove,
  degreesPerCount,
  median,
  mulberry32,
  protocolFor,
  spawnTarget,
  sphericalAngularDistance,
  summarizeHistogram,
  TEST_PROTOCOLS,
  type Target,
  type TestMode,
  type DeviceProfile,
  wrapDegrees,
} from './core';
import {
  createRenderer,
  type RenderState,
  type VisualTarget,
} from './renderer';
import {
  freshMetrics,
  parseRun,
  type Click,
  type Metrics,
  type RunData,
} from './schema';
import { INPUT_BACKEND } from './input';

const ResultEvidence = lazy(() => import('./result-evidence'));

const INPUT_CLASS =
  'h-9 rounded-none border-2 border-plum/35 bg-white/75 px-2.5 font-mono text-[11px] shadow-none focus-visible:border-pink focus-visible:ring-2 focus-visible:ring-pink/20';
const SELECT_CLASS =
  'h-9 min-w-0 rounded-none border-2 border-plum/35 bg-white/75 px-2.5 font-mono text-[10px] text-foreground outline-none transition focus:border-pink focus:ring-2 focus:ring-pink/20 disabled:opacity-50';
const PANEL_CLASS =
  'rounded-none border-2 border-plum/55 bg-card/90 shadow-[4px_4px_0_0_var(--color-pink-soft)] ring-0';
const PIXEL_LABEL =
  'font-pixel text-[8px] uppercase leading-relaxed tracking-[0.08em] text-plum';

type Mode = 'ready' | 'running' | 'result' | 'replay';
type Runtime = {
  mode: 'running' | 'stopped';
  settings: RunData['settings'];
  start: number;
  yaw: number;
  pitch: number;
  active: VisualTarget[];
  targets: Target[];
  clicks: Click[];
  nextTargetId: number;
  nextReflexAt: number;
  firing: boolean;
  trackingOnMs: number;
  trackingTotalMs: number;
  frames: Float32Array;
  frameCount: number;
  moveT: Float64Array;
  moveDx: Float32Array;
  moveDy: Float32Array;
  moveYaw: Float32Array;
  movePitch: Float32Array;
  moveTarget: Int32Array;
  moveCount: number;
  inputCount: number;
  path: number;
  lastFrame: number;
  frameHistogram: Uint32Array;
  frameOverflow: number;
  frameBinMs: number;
  cleanup?: () => void;
  destroy?: () => void;
  longTasks: number;
  longTaskObserver?: PerformanceObserver;
  raf: number;
  uiTimer: number;
};

const PROFILE_STORAGE = 'mouse-migration-lab/profiles';
const SESSION_STORAGE = 'mouse-migration-lab/sessions';
const defaultProfile = (): DeviceProfile => {
  const now = new Date().toISOString();
  return {
    id: 'profile-main',
    name: 'My main mouse',
    mouse: '未命名设备',
    dpi: 800,
    pollingRate: 1000,
    grip: 'claw / relaxed',
    game: 'Valorant',
    sensitivity: 0.32,
    yawDegrees: 0.07,
    mappingSource: 'community-measured',
    fov: 103,
    createdAt: now,
    updatedAt: now,
  };
};

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

const targetDistance = (mode: TestMode, variation = 0.5) => {
  if (mode === 'micro') return 8;
  if (mode === 'four') return 13;
  if (mode === 'tracking') return 16;
  if (mode === 'three') return 24;
  if (mode === 'hold') return 12 + variation * 14;
  return 18;
};

function frameMetrics(rt: Runtime, elapsed: number): Metrics {
  const frames = Array.from(rt.frames.subarray(0, rt.frameCount));
  const sorted = [...frames].sort((a, b) => a - b);
  const quantile = (p: number) =>
    sorted.length
      ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
      : 0;
  const p50 = quantile(0.5);
  const p95 = quantile(0.95);
  const p99 = quantile(0.99);
  const severeThreshold = 2 * (p50 || 1000 / 60);
  let severeCount = 0;
  for (const frame of frames) if (frame > severeThreshold) severeCount += 1;
  const tracking = rt.settings.testMode === 'tracking';
  const hits = tracking
    ? Math.round(rt.trackingOnMs)
    : rt.clicks.filter((click) => click.hit).length;
  const misses = tracking
    ? Math.round(Math.max(0, rt.trackingTotalMs - rt.trackingOnMs))
    : rt.clicks.length - hits;
  return {
    hits,
    misses,
    accuracy: tracking
      ? rt.trackingTotalMs
        ? rt.trackingOnMs / rt.trackingTotalMs
        : 0
      : rt.clicks.length
        ? hits / rt.clicks.length
        : 0,
    medianAcquisition: median(
      rt.clicks.filter((click) => click.hit).map((click) => click.acquisition),
    ),
    medianError: median(rt.clicks.map((click) => click.error)),
    pathEfficiency: median(
      rt.clicks
        .filter((click) => click.hit)
        .map((click) => click.pathEfficiency),
    ),
    fps: p50 ? 1000 / p50 : 0,
    p50,
    p95,
    p99,
    severeThreshold,
    severeRatio: frames.length ? severeCount / frames.length : 0,
    inputHz: rt.inputCount / Math.max(0.001, elapsed / 1000),
    longTasks: rt.longTasks,
  };
}

export default function Home() {
  const [mode, setMode] = useState<Mode>('ready');
  const [selectedMode, setSelectedMode] = useState<TestMode>('four');
  const [seed, setSeed] = useState('20260901');
  const [duration, setDuration] = useState('30');
  const [sensitivity, setSensitivity] = useState('0.32');
  const [valorantYaw, setValorantYaw] = useState('0.07');
  const [mappingSource, setMappingSource] = useState<
    'community-measured' | 'custom'
  >('community-measured');
  const [profiles, setProfiles] = useState<DeviceProfile[]>([]);
  const [profileId, setProfileId] = useState('profile-main');
  const [profileName, setProfileName] = useState('My main mouse');
  const [mouseName, setMouseName] = useState('未命名设备');
  const [dpi, setDpi] = useState('800');
  const [pollingRate, setPollingRate] = useState('1000');
  const [grip, setGrip] = useState('claw / relaxed');
  const [history, setHistory] = useState<RunData[]>([]);
  const [compareId, setCompareId] = useState('');
  const [metrics, setMetrics] = useState<Metrics>(freshMetrics);
  const [remainingMs, setRemainingMs] = useState(0);
  const [error, setError] = useState('');
  const [run, setRun] = useState<RunData | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const runtime = useRef<Runtime | null>(null);
  const replayRaf = useRef(0);
  const replayRenderer = useRef<{ destroy: () => void } | null>(null);
  const protocol = useMemo(() => protocolFor(selectedMode), [selectedMode]);
  const yawDegrees = clamp(Number(valorantYaw) || 0.07, 0.001, 1);
  const angularSensitivity = degreesPerCount(
    Number(sensitivity) || 0.32,
    yawDegrees,
  );
  const nominalCm360 =
    (360 * 2.54) / (angularSensitivity * (Number(dpi) || 800));
  const activeProfile = useMemo(
    () => profiles.find((item) => item.id === profileId) ?? null,
    [profileId, profiles],
  );
  const comparison = useMemo(
    () =>
      run && compareId
        ? (() => {
            const other = history.find((item) => item.createdAt === compareId);
            if (!other) return null;
            const compatibility = comparisonCompatibility(
              run.settings,
              other.settings,
            );
            return {
              other,
              compatibility,
              deltas: compatibility.compatible
                ? comparisonDeltas(run.metrics, other.metrics)
                : null,
            };
          })()
        : null,
    [compareId, history, run],
  );

  // Loading local-first state is intentionally a one-time hydration bridge.
  // oxlint-disable react/react-compiler
  useEffect(() => {
    try {
      const savedProfiles = JSON.parse(
        localStorage.getItem(PROFILE_STORAGE) ?? 'null',
      ) as DeviceProfile[] | null;
      const nextProfiles =
        Array.isArray(savedProfiles) && savedProfiles.length
          ? savedProfiles
          : [defaultProfile()];
      setProfiles(nextProfiles);
      const first = nextProfiles[0];
      setProfileId(first.id);
      setProfileName(first.name);
      setMouseName(first.mouse);
      setDpi(String(first.dpi));
      setPollingRate(String(first.pollingRate));
      setGrip(first.grip ?? '');
      setSensitivity(String(first.sensitivity));
      setValorantYaw(String(first.yawDegrees ?? 0.07));
      setMappingSource(first.mappingSource ?? 'community-measured');
      const savedSessions = JSON.parse(
        localStorage.getItem(SESSION_STORAGE) ?? '[]',
      ) as unknown;
      if (Array.isArray(savedSessions))
        setHistory(
          savedSessions
            .filter((item): item is RunData => Boolean(parseRun(item)))
            .slice(0, 20),
        );
    } catch {
      setProfiles([defaultProfile()]);
    }
  }, []);
  // oxlint-enable react/react-compiler

  useEffect(() => {
    if (profiles.length)
      localStorage.setItem(PROFILE_STORAGE, JSON.stringify(profiles));
  }, [profiles]);

  const saveProfile = () => {
    const now = new Date().toISOString();
    const next: DeviceProfile = {
      id: profileId || `profile-${now.replaceAll(/\D/g, '')}`,
      name: profileName.trim() || 'Untitled profile',
      mouse: mouseName.trim() || 'Unnamed device',
      dpi: clamp(Number(dpi) || 800, 100, 50000),
      pollingRate: clamp(Number(pollingRate) || 1000, 125, 8000),
      grip: grip.trim(),
      game: 'Valorant',
      sensitivity: clamp(Number(sensitivity) || 0.32, 0.01, 10),
      yawDegrees,
      mappingSource,
      fov: 103,
      createdAt: activeProfile?.createdAt ?? now,
      updatedAt: now,
    };
    setProfiles((previous) => {
      const exists = previous.some((item) => item.id === next.id);
      return exists
        ? previous.map((item) => (item.id === next.id ? next : item))
        : [next, ...previous].slice(0, 8);
    });
    setProfileId(next.id);
    setError('设备配置已保存到本地');
  };
  const selectProfile = (id: string) => {
    const next = profiles.find((item) => item.id === id);
    if (!next) return;
    setProfileId(next.id);
    setProfileName(next.name);
    setMouseName(next.mouse);
    setDpi(String(next.dpi));
    setPollingRate(String(next.pollingRate));
    setGrip(next.grip ?? '');
    setSensitivity(String(next.sensitivity));
    setValorantYaw(String(next.yawDegrees ?? 0.07));
    setMappingSource(next.mappingSource ?? 'community-measured');
  };
  const newProfile = () => {
    const id = `profile-${new Date().toISOString().replaceAll(/\D/g, '')}`;
    setProfileId(id);
    setProfileName(`Mouse profile ${profiles.length + 1}`);
    setMouseName('未命名设备');
    setDpi('800');
    setPollingRate('1000');
    setGrip('');
    setSensitivity('0.32');
    setValorantYaw('0.07');
    setMappingSource('community-measured');
    setError('已创建空白设备配置，填写后保存');
  };

  useEffect(() => {
    if (mode === 'running' || mode === 'replay' || !canvasRef.current) return;
    const preset: Partial<Record<TestMode, [number, number]>> = {
      four: [-5, 2],
      tracking: [0, 0],
      three: [8, 3],
      single: [4, -1],
      reflex: [0, 0],
      micro: [2.5, 1],
      hold: [8, 1.8],
    };
    const [yaw, pitch] = preset[selectedMode] ?? [0, 0];
    const record = spawnTarget(0, 0, 0, 0, yaw, pitch, protocol.radius);
    record.distance = targetDistance(selectedMode, 0.5);
    const preview: VisualTarget = {
      record,
      yaw,
      pitch,
      baseYaw: yaw,
      basePitch: pitch,
      phase: 0,
      direction: 1,
      speed: 1,
      distance: record.distance,
      shape:
        selectedMode === 'tracking' || selectedMode === 'hold'
          ? 'person'
          : 'sphere',
      slot: 0,
      visible: true,
    };
    const previewState: RenderState = {
      yaw: 0,
      pitch: 0,
      targets: [preview],
      occluder: selectedMode === 'hold',
    };
    const renderer = createRenderer(canvasRef.current, previewState, 103);
    if (!renderer) {
      const timer = window.setTimeout(
        () => setError('当前浏览器不支持 WebGL2，无法生成校准舱'),
        0,
      );
      return () => window.clearTimeout(timer);
    }
    renderer?.render();
    return () => renderer?.destroy();
  }, [mode, protocol.radius, selectedMode]);

  const stop = useCallback((next: Mode = 'result') => {
    const rt = runtime.current;
    if (!rt || rt.mode !== 'running') return;
    rt.mode = 'stopped';
    cancelAnimationFrame(rt.raf);
    rt.cleanup?.();
    rt.longTaskObserver?.disconnect();
    rt.destroy?.();
    clearInterval(rt.uiTimer);
    const elapsed = Math.max(1, performance.now() - rt.start);
    const resultMetrics = frameMetrics(rt, elapsed);
    const data: RunData = {
      schema: 2,
      app: 'mouse-migration-lab',
      appVersion: '0.2.0',
      createdAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      elapsedMs: elapsed,
      settings: rt.settings,
      targets: rt.targets,
      movement: {
        t: Array.from(rt.moveT.subarray(0, rt.moveCount)),
        dx: Array.from(rt.moveDx.subarray(0, rt.moveCount)),
        dy: Array.from(rt.moveDy.subarray(0, rt.moveCount)),
        yaw: Array.from(rt.moveYaw.subarray(0, rt.moveCount)),
        pitch: Array.from(rt.movePitch.subarray(0, rt.moveCount)),
        targetId: Array.from(rt.moveTarget.subarray(0, rt.moveCount)),
      },
      clicks: rt.clicks,
      frames: Array.from(rt.frames.subarray(0, rt.frameCount)),
      metrics: resultMetrics,
    };
    try {
      const saved = JSON.parse(
        localStorage.getItem(SESSION_STORAGE) ?? '[]',
      ) as unknown;
      const previous = Array.isArray(saved)
        ? saved.filter((item): item is RunData => Boolean(parseRun(item)))
        : [];
      localStorage.setItem(
        SESSION_STORAGE,
        JSON.stringify([data, ...previous].slice(0, 20)),
      );
      setHistory([data, ...previous].slice(0, 20));
    } catch {
      // A private browsing quota must not interrupt the completed run.
    }
    setMetrics(resultMetrics);
    setRemainingMs(0);
    setRun(data);
    setMode(next);
    runtime.current = null;
  }, []);

  const start = useCallback(async () => {
    setError('');
    if (runtime.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const activeProtocol = protocolFor(selectedMode);
    const valorantSensitivity = clamp(Number(sensitivity) || 0.32, 0.01, 10);
    const settings: RunData['settings'] = {
      seed: Number(seed) || 1,
      duration: clamp(Number(duration) || 30, 5, 120),
      degreesPerCount: degreesPerCount(valorantSensitivity, yawDegrees),
      targetRadius: activeProtocol.radius,
      fov: 103,
      testMode: selectedMode,
      valorantSensitivity,
      gameMapping: {
        profile: 'valorant',
        yawDegrees,
        source: mappingSource,
      },
      device: activeProfile
        ? {
            id: activeProfile.id,
            name: activeProfile.name,
            mouse: activeProfile.mouse,
            dpi: activeProfile.dpi,
            pollingRate: activeProfile.pollingRate,
            grip: activeProfile.grip,
          }
        : {
            id: profileId,
            name: profileName,
            mouse: mouseName,
            dpi: Number(dpi) || 800,
            pollingRate: Number(pollingRate) || 1000,
            grip,
          },
    };
    const random = mulberry32(settings.seed);
    const capacity = settings.duration * 8000;
    const frameCapacity = settings.duration * 1000 + 60;
    const rt: Runtime = {
      mode: 'stopped',
      settings,
      start: 0,
      yaw: 0,
      pitch: 0,
      active: [],
      targets: [],
      clicks: [],
      nextTargetId: 0,
      nextReflexAt: 0,
      firing: false,
      trackingOnMs: 0,
      trackingTotalMs: 0,
      frames: new Float32Array(frameCapacity),
      frameCount: 0,
      moveT: new Float64Array(capacity),
      moveDx: new Float32Array(capacity),
      moveDy: new Float32Array(capacity),
      moveYaw: new Float32Array(capacity),
      movePitch: new Float32Array(capacity),
      moveTarget: new Int32Array(capacity),
      moveCount: 0,
      inputCount: 0,
      path: 0,
      lastFrame: 0,
      frameHistogram: new Uint32Array(128),
      frameOverflow: 0,
      frameBinMs: 1,
      longTasks: 0,
      raf: 0,
      uiTimer: 0,
    };
    const initialPositions: Partial<Record<TestMode, Array<[number, number]>>> =
      {
        four: [
          [-11, 5],
          [-4, 1],
          [4, 6],
          [11, 8],
        ],
        three: [
          [-24, -5],
          [0, 9],
          [24, -5],
        ],
        micro: [
          [-4.5, 0],
          [0, 3],
          [4.5, -1],
        ],
      };
    const spawn = (now: number, slot: number) => {
      const preset =
        rt.nextTargetId < activeProtocol.targetCount
          ? initialPositions[selectedMode]?.[slot]
          : undefined;
      let yaw = preset?.[0] ?? 0;
      let pitch = preset?.[1] ?? 0;
      if (!preset) {
        if (selectedMode === 'micro') {
          yaw = (random() * 2 - 1) * 6;
          pitch = (random() * 2 - 1) * 3.2;
        } else if (selectedMode === 'tracking' || selectedMode === 'hold') {
          yaw = 0;
          pitch = selectedMode === 'hold' ? 1.8 : 0;
        } else {
          yaw = (random() * 2 - 1) * 27;
          pitch = (random() * 2 - 1) * 11;
        }
      }
      const record = spawnTarget(
        rt.nextTargetId,
        now,
        0,
        0,
        yaw,
        pitch,
        activeProtocol.radius,
      );
      const distance = targetDistance(selectedMode, random());
      record.distance = distance;
      rt.nextTargetId += 1;
      rt.targets.push(record);
      const visual: VisualTarget = {
        record,
        yaw,
        pitch,
        baseYaw: yaw,
        basePitch: pitch,
        phase: random() * Math.PI * 2,
        direction: random() < 0.5 ? -1 : 1,
        speed: 0.75 + random() * 0.45,
        distance,
        shape:
          selectedMode === 'tracking' || selectedMode === 'hold'
            ? 'person'
            : 'sphere',
        slot,
        visible: true,
      };
      if (selectedMode === 'tracking' || selectedMode === 'hold') {
        record.behavior = selectedMode;
        record.phase = visual.phase;
        record.direction = visual.direction;
        record.speed = visual.speed;
      }
      rt.active.push(visual);
      return visual;
    };
    if (selectedMode === 'reflex') rt.nextReflexAt = 600 + random() * 1400;
    else
      for (let index = 0; index < activeProtocol.targetCount; index += 1)
        spawn(0, index);

    const renderState: RenderState = {
      get yaw() {
        return rt.yaw;
      },
      get pitch() {
        return rt.pitch;
      },
      targets: rt.active,
      occluder: selectedMode === 'hold',
    };
    const renderer = createRenderer(canvas, renderState, settings.fov);
    if (!renderer) {
      setError('当前浏览器不支持 WebGL2');
      return;
    }
    rt.destroy = renderer.destroy;
    runtime.current = rt;
    const updateTargets = (elapsed: number) => {
      if (
        selectedMode === 'reflex' &&
        rt.active.length === 0 &&
        elapsed >= rt.nextReflexAt
      )
        spawn(elapsed, 0);
      const seconds = elapsed / 1000;
      for (const target of rt.active) {
        if (selectedMode === 'tracking') {
          target.yaw = Math.sin(seconds * 1.65 + target.phase) * 16;
          const jump = Math.max(0, Math.sin(seconds * 1.25 + target.phase));
          target.pitch = target.basePitch + Math.pow(jump, 10) * 4.2;
        } else if (selectedMode === 'hold') {
          const travel = ((seconds * target.speed + target.phase) % 2) - 1;
          const triangle = 1 - 2 * Math.abs(travel);
          target.yaw = triangle * 15 * target.direction;
          target.pitch = target.basePitch;
          // The middle cover is opaque: the target is only hittable after it
          // has committed to a side peek, then changes side/distance on hit.
          target.visible = Math.abs(target.yaw) > 5.5;
        }
      }
    };
    const nearest = () => {
      let best: VisualTarget | null = null;
      let error = Number.POSITIVE_INFINITY;
      for (const target of rt.active) {
        if (!target.visible) continue;
        const current = sphericalAngularDistance(
          rt.yaw,
          rt.pitch,
          target.yaw,
          target.pitch,
        );
        if (current < error) {
          best = target;
          error = current;
        }
      }
      return { target: best, error };
    };
    const shoot = () => {
      if (rt.mode !== 'running') return;
      const now = performance.now() - rt.start;
      updateTargets(now);
      const { target, error: angularError } = nearest();
      const hit = Boolean(target && angularError <= target.record.radius);
      rt.clicks.push({
        t: now,
        targetId: target?.record.id ?? -1,
        hit,
        error: Number.isFinite(angularError) ? angularError : 180,
        acquisition: target ? now - target.record.spawn : 0,
        pathEfficiency: target
          ? rt.path / Math.max(0.001, target.record.idealDistance)
          : 0,
      });
      if (!hit || !target) return;
      target.record.despawn = now;
      const index = rt.active.indexOf(target);
      if (index >= 0) rt.active.splice(index, 1);
      rt.path = 0;
      if (selectedMode === 'reflex')
        rt.nextReflexAt = now + 550 + random() * 1550;
      else {
        const next = spawn(now, target.slot);
        if (selectedMode === 'hold') {
          next.direction = random() < 0.5 ? -1 : 1;
          next.distance = targetDistance('hold', random());
        }
      }
    };
    const onMove = (dx: number, dy: number) => {
      if (rt.mode !== 'running') return;
      if (rt.moveCount >= capacity) {
        setError('记录缓冲已满，运行已停止');
        stop();
        return;
      }
      rt.yaw = wrapDegrees(rt.yaw - dx * settings.degreesPerCount);
      rt.pitch = clamp(rt.pitch - dy * settings.degreesPerCount, -67.6, 67.6);
      rt.path += Math.hypot(dx, dy) * settings.degreesPerCount;
      const index = rt.moveCount++;
      rt.moveT[index] = performance.now() - rt.start;
      rt.moveDx[index] = dx;
      rt.moveDy[index] = dy;
      rt.moveYaw[index] = rt.yaw;
      rt.movePitch[index] = rt.pitch;
      rt.moveTarget[index] = rt.active[0]?.record.id ?? -1;
      rt.inputCount += 1;
    };
    const onDown = (button: number) => {
      if (button !== 0 || rt.mode !== 'running') return;
      if (selectedMode === 'tracking') rt.firing = true;
      else shoot();
    };
    const onUp = (button: number) => {
      if (button === 0) rt.firing = false;
    };
    const input = await INPUT_BACKEND.acquire(canvas, {
      move: onMove,
      buttonDown: onDown,
      buttonUp: onUp,
      lost: () => stop(),
    });
    if (!input) {
      rt.destroy?.();
      runtime.current = null;
      setMode('ready');
      setError(`无法获取 ${INPUT_BACKEND.label}，运行未开始`);
      return;
    }
    rt.cleanup = input.release;
    rt.settings.inputBackend = {
      id: input.id,
      native: input.native,
      unadjusted: input.unadjusted,
    };
    rt.start = performance.now();
    rt.lastFrame = rt.start;
    rt.mode = 'running';
    setMode('running');
    setRemainingMs(settings.duration * 1000);
    const observer =
      'PerformanceObserver' in window
        ? new PerformanceObserver((list) => {
            rt.longTasks += list.getEntries().length;
          })
        : null;
    try {
      observer?.observe({ type: 'longtask' } as PerformanceObserverInit);
    } catch {
      /* long tasks are optional browser telemetry */
    }
    if (observer) rt.longTaskObserver = observer;
    const frame = (now: number) => {
      if (rt.mode !== 'running') return;
      if (rt.frameCount >= rt.frames.length) {
        setError('帧记录缓冲已满，运行已停止');
        stop();
        return;
      }
      const delta = now - rt.lastFrame;
      rt.frames[rt.frameCount++] = delta;
      const bin = Math.floor(delta / rt.frameBinMs);
      if (bin < rt.frameHistogram.length) rt.frameHistogram[bin] += 1;
      else rt.frameOverflow += 1;
      rt.lastFrame = now;
      const elapsed = now - rt.start;
      updateTargets(elapsed);
      if (selectedMode === 'tracking' && rt.firing) {
        rt.trackingTotalMs += delta;
        const { target, error: trackingError } = nearest();
        if (target && trackingError <= target.record.radius)
          rt.trackingOnMs += delta;
      }
      renderer.render();
      if (elapsed >= settings.duration * 1000) {
        stop();
        return;
      }
      // oxlint-disable-next-line react/react-compiler
      rt.raf = requestAnimationFrame(frame);
    };
    rt.uiTimer = window.setInterval(() => {
      if (rt.mode !== 'running') return;
      const summary = summarizeHistogram(
        rt.frameHistogram,
        rt.frameOverflow,
        rt.frameBinMs,
      );
      const severeThreshold = 2 * (summary.p50 || 1000 / 60);
      const elapsed = performance.now() - rt.start;
      const tracking = selectedMode === 'tracking';
      const hitCount = rt.clicks.filter((click) => click.hit).length;
      setMetrics((previous) => ({
        ...previous,
        hits: tracking ? Math.round(rt.trackingOnMs) : hitCount,
        misses: tracking
          ? Math.round(Math.max(0, rt.trackingTotalMs - rt.trackingOnMs))
          : rt.clicks.length - hitCount,
        accuracy: tracking
          ? rt.trackingTotalMs
            ? rt.trackingOnMs / rt.trackingTotalMs
            : 0
          : rt.clicks.length
            ? hitCount / rt.clicks.length
            : 0,
        fps: summary.p50 ? 1000 / summary.p50 : 0,
        p50: summary.p50,
        p95: summary.p95,
        p99: summary.p99,
        severeThreshold,
        severeRatio: summary.count
          ? countAbove(
              rt.frameHistogram,
              severeThreshold,
              rt.frameBinMs,
              rt.frameOverflow,
            ) / summary.count
          : 0,
        inputHz: rt.inputCount / Math.max(0.25, elapsed / 1000),
        longTasks: rt.longTasks,
      }));
      setRemainingMs(Math.max(0, settings.duration * 1000 - elapsed));
    }, 500);
    rt.raf = requestAnimationFrame(frame);
  }, [
    activeProfile,
    dpi,
    duration,
    grip,
    mouseName,
    pollingRate,
    profileId,
    profileName,
    seed,
    selectedMode,
    sensitivity,
    yawDegrees,
    mappingSource,
    stop,
  ]);

  useEffect(
    () => () => {
      const rt = runtime.current;
      if (rt?.mode === 'running') stop();
      else if (rt) {
        rt.cleanup?.();
        rt.destroy?.();
        runtime.current = null;
      }
      cancelAnimationFrame(replayRaf.current);
      replayRenderer.current?.destroy();
      replayRenderer.current = null;
    },
    [stop],
  );

  const replay = useCallback(() => {
    if (!run || !canvasRef.current) return;
    cancelAnimationFrame(replayRaf.current);
    replayRenderer.current?.destroy();
    const visuals = run.targets.map<VisualTarget>((target) => ({
      record: target,
      yaw: target.yaw,
      pitch: target.pitch,
      baseYaw: target.yaw,
      basePitch: target.pitch,
      phase: 0,
      direction: 1,
      speed: 1,
      distance: target.distance ?? targetDistance(run.settings.testMode, 0.5),
      shape:
        run.settings.testMode === 'tracking' || run.settings.testMode === 'hold'
          ? 'person'
          : 'sphere',
      slot: 0,
      visible: true,
    }));
    const state: RenderState = {
      yaw: 0,
      pitch: 0,
      targets: [],
      occluder: run.settings.testMode === 'hold',
    };
    const renderer = createRenderer(canvasRef.current, state, run.settings.fov);
    if (!renderer) return;
    replayRenderer.current = renderer;
    setMode('replay');
    const startAt = performance.now();
    let movementIndex = -1;
    const endAt = run.elapsedMs + 500;
    const tick = (now: number) => {
      const elapsed = now - startAt;
      const seconds = elapsed / 1000;
      while (
        movementIndex + 1 < run.movement.t.length &&
        run.movement.t[movementIndex + 1] <= elapsed
      )
        movementIndex += 1;
      if (movementIndex >= 0) {
        state.yaw = run.movement.yaw[movementIndex] ?? 0;
        state.pitch = run.movement.pitch[movementIndex] ?? 0;
      }
      state.targets.length = 0;
      for (const visual of visuals) {
        if (visual.record.behavior === 'tracking') {
          visual.yaw =
            Math.sin(seconds * 1.65 + (visual.record.phase ?? 0)) * 16;
          visual.pitch =
            visual.basePitch +
            Math.pow(
              Math.max(
                0,
                Math.sin(seconds * 1.25 + (visual.record.phase ?? 0)),
              ),
              10,
            ) *
              4.2;
        } else if (visual.record.behavior === 'hold') {
          const travel =
            ((seconds * (visual.record.speed ?? 1) +
              (visual.record.phase ?? 0)) %
              2) -
            1;
          visual.yaw =
            (1 - 2 * Math.abs(travel)) * 15 * (visual.record.direction ?? 1);
          visual.visible = Math.abs(visual.yaw) > 5.5;
        }
        if (
          visual.record.spawn <= elapsed &&
          (visual.record.despawn === undefined ||
            visual.record.despawn > elapsed)
        )
          state.targets.push(visual);
      }
      renderer.render();
      // oxlint-disable-next-line react/react-compiler
      if (elapsed < endAt) replayRaf.current = requestAnimationFrame(tick);
      else {
        renderer.destroy();
        replayRenderer.current = null;
        setMode('result');
      }
    };
    replayRaf.current = requestAnimationFrame(tick);
  }, [run]);

  const exportRun = () => {
    if (!run) return;
    const blob = new Blob([JSON.stringify(run)], { type: 'application/json' });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = `mouse-migration-${run.settings.testMode}-${run.settings.seed}.json`;
    anchor.click();
    URL.revokeObjectURL(href);
  };
  const importRun = (file: File) => {
    if (file.size > 256 * 1024 * 1024) {
      setError('JSON 文件超过 256 MB，当前结果未改变');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const raw = typeof reader.result === 'string' ? reader.result : '';
        const parsed = parseRun(JSON.parse(raw));
        if (!parsed) throw new Error('schema');
        setRun(parsed);
        setSelectedMode(parsed.settings.testMode);
        setMetrics(parsed.metrics);
        setMode('result');
        setError('');
      } catch {
        setError('JSON 无效或版本不兼容，当前结果未改变');
      }
    };
    reader.readAsText(file);
  };
  const reset = () => {
    cancelAnimationFrame(replayRaf.current);
    replayRenderer.current?.destroy();
    replayRenderer.current = null;
    setMode('ready');
    setRun(null);
    setMetrics(freshMetrics());
    setRemainingMs(0);
    setError('');
  };
  const status =
    mode === 'running'
      ? 'RUNNING'
      : mode === 'replay'
        ? 'REPLAY'
        : mode === 'result'
          ? 'RESULT'
          : 'READY';
  const trackingMode = selectedMode === 'tracking';
  const lockedView = mode === 'running' || mode === 'replay';
  const highScore = Math.max(
    0,
    ...history.map((item) => Math.round(item.metrics.accuracy * 999999)),
  )
    .toString()
    .padStart(6, '0');

  return (
    <main className="min-h-screen overflow-x-hidden bg-background bg-[radial-gradient(circle_at_1px_1px,rgba(111,35,78,0.08)_1px,transparent_0)] [background-size:16px_16px] text-foreground selection:bg-pink selection:text-plum">
      {!lockedView && (
        <header className="relative z-20 border-b-2 border-plum/70 bg-white/85 shadow-[0_4px_0_0_var(--color-pink-soft)] backdrop-blur-md">
          <div className="mx-auto flex h-[74px] max-w-[1720px] items-center justify-between gap-4 px-4 sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <span className="grid size-10 shrink-0 place-items-center border-2 border-plum bg-pink text-white shadow-[3px_3px_0_0_var(--color-plum)]">
                <Zap size={17} strokeWidth={2.5} />
              </span>
              <span className="min-w-0">
                <small className="block font-pixel text-[7px] tracking-[0.1em] text-plum/65">
                  PLAYER 01
                </small>
                <b className="mt-1 block truncate font-pixel text-[9px] uppercase tracking-[0.04em] sm:text-[10px]">
                  Mouse Migration Lab
                </b>
              </span>
            </div>

            <div
              className="hidden text-center md:block"
              aria-label={`最高分 ${highScore}`}
            >
              <span className="block font-pixel text-[7px] tracking-[0.1em] text-plum/55">
                HIGH SCORE
              </span>
              <strong className="mt-1 block font-mono text-sm tracking-[0.22em] text-plum">
                {highScore}
              </strong>
            </div>

            <div className="flex shrink-0 items-center gap-3">
              <span
                className="hidden font-pixel text-[13px] tracking-[-0.16em] text-pink [text-shadow:1px_1px_0_var(--color-plum)] sm:inline"
                aria-label="五颗生命值"
              >
                ♥♥♥♥♥
              </span>
              <Badge
                variant="outline"
                className="rounded-none border-2 border-plum bg-white px-2 py-1 font-pixel text-[7px] text-plum shadow-[2px_2px_0_0_var(--color-pink-soft)]"
              >
                {status}
              </Badge>
            </div>
          </div>
        </header>
      )}

      <section
        className={cn(
          'relative mx-auto grid max-w-[1720px] grid-cols-1 gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[310px_minmax(0,1fr)] lg:items-start xl:grid-cols-[290px_minmax(0,1fr)_260px]',
          lockedView && 'fixed inset-0 z-50 block max-w-none p-0',
        )}
      >
        {!lockedView && (
          <aside className="order-2 space-y-5 lg:order-1">
            <div>
              <div className={PIXEL_LABEL}>01 / Test protocol</div>
              <h1 className="mt-3 text-[clamp(1.9rem,4vw,3.25rem)] leading-[0.98] font-black tracking-[-0.055em] text-plum lg:text-[2.7rem]">
                固定世界，
                <br />
                <em className="font-black not-italic text-pink [text-shadow:2px_2px_0_#fff,4px_4px_0_var(--color-pink-soft)]">
                  只让视角动。
                </em>
              </h1>
              <p className="mt-4 max-w-md text-[13px] leading-6 text-muted-foreground">
                为换鼠标建立可复现的证据链。锁定协议与设备，再进入 raw input
                训练。
              </p>
            </div>

            <Card className={PANEL_CLASS}>
              <CardHeader className="flex flex-row items-center justify-between gap-3 px-4 pb-1">
                <CardTitle className="flex items-center gap-2 font-pixel text-[9px] uppercase text-plum">
                  <SlidersHorizontal className="size-3.5" /> Calibration Dock
                </CardTitle>
                <span className="font-mono text-[8px] tracking-[0.08em] text-muted-foreground">
                  LOCAL PROFILE
                </span>
              </CardHeader>
              <CardContent className="space-y-3 px-4">
                <div className="grid grid-cols-[minmax(0,1fr)_36px_36px] gap-2">
                  <select
                    className={SELECT_CLASS}
                    value={profileId}
                    onChange={(event) => selectProfile(event.target.value)}
                    aria-label="设备配置"
                  >
                    {profiles.length === 0 && (
                      <option value="profile-main">新设备配置</option>
                    )}
                    {profileId &&
                      !profiles.some((item) => item.id === profileId) && (
                        <option value={profileId}>
                          {profileName} · 未保存草稿
                        </option>
                      )}
                    {profiles.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} · {item.mouse}
                      </option>
                    ))}
                  </select>
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-9 rounded-none border-2 border-plum/45 bg-white text-plum hover:bg-pink-soft"
                    type="button"
                    onClick={newProfile}
                    disabled={lockedView}
                    aria-label="新建设备配置"
                    title="新建设备配置"
                  >
                    <Plus size={14} />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-9 rounded-none border-2 border-plum/45 bg-white text-plum hover:bg-pink-soft"
                    type="button"
                    onClick={saveProfile}
                    aria-label="保存设备配置"
                  >
                    <Save size={14} />
                  </Button>
                </div>

                <Field label="配置名称" htmlFor="profile-name">
                  <Input
                    className={INPUT_CLASS}
                    id="profile-name"
                    value={profileName}
                    onChange={(event) => setProfileName(event.target.value)}
                    disabled={lockedView}
                  />
                </Field>

                <Field label="设备" htmlFor="mouse-name">
                  <Input
                    className={INPUT_CLASS}
                    id="mouse-name"
                    value={mouseName}
                    onChange={(event) => setMouseName(event.target.value)}
                    disabled={lockedView}
                  />
                </Field>

                <div className="grid grid-cols-2 gap-2">
                  <Field label="DPI" htmlFor="dpi">
                    <Input
                      className={INPUT_CLASS}
                      id="dpi"
                      type="number"
                      value={dpi}
                      onChange={(event) => setDpi(event.target.value)}
                      disabled={lockedView}
                    />
                  </Field>
                  <Field label="Hz" htmlFor="polling">
                    <Input
                      className={INPUT_CLASS}
                      id="polling"
                      type="number"
                      value={pollingRate}
                      onChange={(event) => setPollingRate(event.target.value)}
                      disabled={lockedView}
                    />
                  </Field>
                </div>

                <Field label="握法备注" hint="optional" htmlFor="grip">
                  <Input
                    className={INPUT_CLASS}
                    id="grip"
                    placeholder="例如：claw / relaxed"
                    value={grip}
                    onChange={(event) => setGrip(event.target.value)}
                    disabled={lockedView}
                  />
                </Field>

                <div className="flex items-center justify-between gap-2 border-t border-plum/15 pt-3 font-mono text-[8px] text-muted-foreground">
                  <span className="flex items-center gap-1.5 text-plum/70">
                    <Radio className="size-3" /> Valorant / 103° H-FOV
                  </span>
                  <span>
                    {Number(dpi) || 800} DPI · {Number(pollingRate) || 1000} Hz
                  </span>
                </div>
              </CardContent>
            </Card>

            <div>
              <div className={PIXEL_LABEL}>02 / Choose a protocol</div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
                {TEST_PROTOCOLS.map((item, index) => {
                  const active = item.id === selectedMode;
                  return (
                    <button
                      key={item.id}
                      className={cn(
                        'group grid min-h-14 grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-x-2 border-2 border-plum/35 bg-white/70 px-3 py-2 text-left transition duration-150 hover:-translate-y-0.5 hover:border-plum hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pink',
                        active &&
                          'border-plum bg-pink-soft/80 shadow-[3px_3px_0_0_var(--color-plum)]',
                      )}
                      onClick={() => {
                        setSelectedMode(item.id);
                        reset();
                      }}
                      disabled={lockedView}
                    >
                      <span className="font-mono text-[9px] text-plum/45">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <span className="min-w-0">
                        <strong className="block text-xs font-semibold text-foreground">
                          {item.name}
                        </strong>
                        <span className="mt-0.5 block truncate font-mono text-[8px] text-muted-foreground">
                          {item.short}
                        </span>
                      </span>
                      {active ? (
                        <Check className="size-3.5 text-plum" />
                      ) : (
                        <ChevronRight className="size-3.5 text-plum/25 transition group-hover:translate-x-0.5 group-hover:text-plum" />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            <Card className={PANEL_CLASS}>
              <CardHeader className="px-4 pb-1">
                <CardTitle className="font-pixel text-[9px] uppercase text-plum">
                  标定与时长
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 px-4">
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Seed" htmlFor="seed">
                    <Input
                      className={INPUT_CLASS}
                      id="seed"
                      value={seed}
                      onChange={(event) => setSeed(event.target.value)}
                      disabled={lockedView}
                    />
                  </Field>
                  <Field label="秒" htmlFor="duration">
                    <Input
                      className={INPUT_CLASS}
                      id="duration"
                      type="number"
                      min="5"
                      max="120"
                      value={duration}
                      onChange={(event) => setDuration(event.target.value)}
                      disabled={lockedView}
                    />
                  </Field>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Field
                    label="Valorant 映射"
                    hint="游戏内 sens"
                    htmlFor="sensitivity"
                  >
                    <Input
                      className={INPUT_CLASS}
                      id="sensitivity"
                      type="number"
                      step="0.01"
                      min="0.01"
                      max="10"
                      value={sensitivity}
                      onChange={(event) => setSensitivity(event.target.value)}
                      disabled={lockedView}
                    />
                  </Field>
                  <Field label="Yaw 模型" hint="° / sens / count" htmlFor="yaw">
                    <Input
                      className={INPUT_CLASS}
                      id="yaw"
                      type="number"
                      step="0.0001"
                      min="0.001"
                      max="1"
                      value={valorantYaw}
                      onChange={(event) => {
                        setValorantYaw(event.target.value);
                        setMappingSource('custom');
                      }}
                      disabled={lockedView}
                    />
                  </Field>
                </div>
                <Field label="映射证据" htmlFor="mapping-source">
                  <select
                    className={SELECT_CLASS}
                    id="mapping-source"
                    value={mappingSource}
                    disabled={lockedView}
                    onChange={(event) => {
                      const source = event.target.value as
                        | 'community-measured'
                        | 'custom';
                      setMappingSource(source);
                      if (source === 'community-measured')
                        setValorantYaw('0.07');
                    }}
                  >
                    <option value="community-measured">
                      公共工具实测（Riot 未公开）
                    </option>
                    <option value="custom">自定义 / 自行实测</option>
                  </select>
                </Field>
                <div className="border-l-2 border-pink pl-2 font-mono text-[9px] leading-relaxed text-muted-foreground">
                  测试核心 {angularSensitivity.toFixed(4)}° / input unit · 标称{' '}
                  {nominalCm360.toFixed(2)} cm / 360°
                  <br />
                  103° H-FOV · DPI 仅用于标称距离，不参与角度积分
                </div>
                <div className="flex gap-2 pt-1">
                  <Button
                    className="h-10 flex-1 rounded-none border-2 border-plum bg-pink font-pixel text-[8px] text-white shadow-[3px_3px_0_0_var(--color-plum)] hover:-translate-y-0.5 hover:bg-pink/90 hover:shadow-[4px_4px_0_0_var(--color-plum)] active:translate-y-0 active:shadow-[1px_1px_0_0_var(--color-plum)]"
                    onClick={start}
                    disabled={lockedView}
                  >
                    <MousePointer2 className="size-3.5" />
                    {mode === 'result' ? 'RETRY' : 'PRESS START'}
                  </Button>
                  <Button
                    className="size-10 rounded-none border-2 border-plum/45 bg-white text-plum hover:bg-pink-soft"
                    variant="outline"
                    size="icon"
                    onClick={reset}
                    aria-label="重置"
                  >
                    <RotateCcw size={15} />
                  </Button>
                </div>
              </CardContent>
            </Card>

            <div className="border-t-2 border-plum/20 pt-4">
              <div className={PIXEL_LABEL}>Performance contract</div>
              <div className="mt-3 divide-y divide-plum/15 border-y border-plum/15 font-mono text-[9px]">
                <ContractRow label="世界坐标" value="固定，不随命中漂移" />
                <ContractRow
                  label="输入"
                  value={
                    run?.settings.inputBackend
                      ? `${run.settings.inputBackend.id} · ${
                          run.settings.inputBackend.unadjusted
                            ? 'unadjusted'
                            : 'adjusted fallback'
                        }`
                      : `${INPUT_BACKEND.label} · raw requested`
                  }
                />
                <ContractRow
                  label="游戏映射"
                  value={
                    run?.settings.gameMapping
                      ? `${run.settings.gameMapping.yawDegrees} yaw · ${
                          run.settings.gameMapping.source ===
                          'community-measured'
                            ? '公共实测'
                            : '自定义'
                        }`
                      : `${yawDegrees} yaw · ${
                          mappingSource === 'community-measured'
                            ? '公共实测估算'
                            : '自定义'
                        }`
                  }
                />
                <ContractRow label="React UI" value="2 次 / 秒" />
              </div>
            </div>

            {history.length > 0 && (
              <div>
                <div className={cn(PIXEL_LABEL, 'flex items-center gap-2')}>
                  <History className="size-3" /> Recent sessions
                  <span className="text-plum/35">/{history.length}</span>
                </div>
                <div className="mt-3 divide-y divide-plum/15 border-y border-plum/20">
                  {history.slice(0, 3).map((item) => (
                    <button
                      key={`${item.createdAt}-${item.settings.seed}`}
                      className={cn(
                        'grid w-full grid-cols-[8px_minmax(0,1fr)_auto_14px] items-center gap-2 py-2.5 text-left transition hover:bg-white/70',
                        run?.createdAt === item.createdAt && 'bg-pink-soft/35',
                      )}
                      onClick={() => {
                        setRun(item);
                        setSelectedMode(item.settings.testMode);
                        setMetrics(item.metrics);
                        setCompareId('');
                        setMode('result');
                      }}
                    >
                      <span className="size-1.5 bg-pink" />
                      <span className="min-w-0">
                        <b className="block truncate text-[11px]">
                          {item.settings.device?.name ??
                            protocolFor(item.settings.testMode).name}
                        </b>
                        <small className="block truncate font-mono text-[8px] text-muted-foreground">
                          {new Date(item.createdAt).toLocaleDateString('zh-CN')}{' '}
                          · {protocolFor(item.settings.testMode).name}
                        </small>
                      </span>
                      <strong className="font-mono text-[10px] text-plum">
                        {Math.round(item.metrics.accuracy * 100)}%
                      </strong>
                      <ChevronRight className="size-3 text-plum/35" />
                    </button>
                  ))}
                </div>
              </div>
            )}
          </aside>
        )}

        <section
          className={cn(
            'order-1 min-w-0 lg:order-2',
            lockedView && 'h-screen w-screen',
          )}
        >
          {!lockedView && (
            <div className="mb-3 flex items-end justify-between gap-4">
              <div>
                <div className={PIXEL_LABEL}>03 / {protocol.name}</div>
                <h2 className="mt-2 max-w-2xl text-base font-bold leading-snug text-plum sm:text-lg">
                  {protocol.description}
                </h2>
              </div>
              <div className="hidden items-center gap-2 font-mono text-[9px] text-muted-foreground sm:flex">
                <Activity className="size-3.5 text-pink" />
                <span>
                  {mode === 'result' ? '结果可回放' : '点击开始后锁定鼠标'}
                </span>
              </div>
            </div>
          )}

          <div
            className={cn(
              'relative h-[clamp(430px,64vh,760px)] overflow-hidden border-[3px] border-plum bg-[#d9ced8] shadow-[7px_7px_0_0_var(--color-pink-soft)]',
              lockedView && 'h-screen border-0 shadow-none',
            )}
          >
            <canvas
              ref={canvasRef}
              className="block size-full touch-none"
              aria-label="WebGL 固定世界训练场"
            />

            <div className="pointer-events-none absolute left-1/2 top-1/2 z-20 size-7 -translate-x-1/2 -translate-y-1/2">
              <span className="absolute left-1/2 top-0 h-full w-[2px] -translate-x-1/2 bg-white shadow-[0_0_0_1px_var(--color-plum)]" />
              <span className="absolute left-0 top-1/2 h-[2px] w-full -translate-y-1/2 bg-white shadow-[0_0_0_1px_var(--color-plum)]" />
              <span className="absolute left-1/2 top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 bg-pink shadow-[0_0_0_1px_var(--color-plum)]" />
            </div>

            {mode === 'running' && (
              <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex items-start justify-between gap-4 p-5 text-white [text-shadow:1px_1px_0_#3d1830]">
                <span className="font-pixel text-[8px] uppercase tracking-[0.08em]">
                  {protocol.name}
                </span>
                <strong className="font-mono text-2xl font-black tabular-nums">
                  {(remainingMs / 1000).toFixed(1)}
                  <small className="ml-1 text-[10px]">S</small>
                </strong>
                <span className="flex items-center gap-2 font-pixel text-[7px] uppercase tracking-[0.06em]">
                  <i className="size-1.5 animate-pulse bg-pink" /> RAW INPUT
                </span>
              </div>
            )}

            {mode === 'running' && selectedMode === 'hold' && (
              <div className="pointer-events-none absolute bottom-8 left-1/2 z-30 -translate-x-1/2 border-2 border-white/75 bg-plum/75 px-4 py-2 text-center text-white backdrop-blur-sm">
                <span className="block font-pixel text-[7px]">PEEK WINDOW</span>
                <b className="mt-1 block text-xs">只在开口出现时开火</b>
              </div>
            )}

            {mode !== 'running' && mode !== 'replay' && (
              <div className="absolute inset-0 z-10 grid place-items-center bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.2),rgba(111,35,78,0.08))] p-5">
                {mode === 'ready' ? (
                  <button
                    className="group min-w-[250px] border-[3px] border-plum bg-white/78 px-8 py-8 text-center shadow-[7px_7px_0_0_rgba(111,35,78,0.25)] backdrop-blur-[2px] transition duration-150 hover:-translate-y-1 hover:bg-white/90 hover:shadow-[9px_9px_0_0_rgba(111,35,78,0.32)] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-pink/45 active:translate-y-0 active:shadow-[3px_3px_0_0_rgba(111,35,78,0.28)]"
                    type="button"
                    onClick={start}
                  >
                    <span className="font-pixel text-[8px] tracking-[0.13em] text-plum/75">
                      MOUSE MIGRATION
                    </span>
                    <strong className="my-4 flex flex-col items-center gap-3 font-pixel text-[clamp(2.1rem,4.2vw,4rem)] leading-none text-pink [text-shadow:3px_0_0_#7b1f4e,-3px_0_0_#7b1f4e,0_3px_0_#7b1f4e,0_-3px_0_#7b1f4e,5px_5px_0_#fff] transition-transform group-hover:scale-[1.02]">
                      <span className="block">PRESS</span>
                      <span className="flex items-center justify-center gap-[0.18em]">
                        START
                        <i className="text-[0.68em] not-italic">♥</i>
                      </span>
                    </strong>
                    <small className="font-pixel text-[7px] tracking-[0.1em] text-plum/65">
                      CLICK TO LOCK AIM
                    </small>
                  </button>
                ) : (
                  <div className="max-w-sm border-[3px] border-plum bg-white/85 px-8 py-7 text-center shadow-[7px_7px_0_0_var(--color-pink-soft)] backdrop-blur-sm">
                    <div className="mx-auto grid size-11 place-items-center border-2 border-plum bg-pink-soft text-plum">
                      <Crosshair className="size-5" />
                    </div>
                    <b className="mt-4 block font-pixel text-[9px] uppercase text-plum">
                      Session captured
                    </b>
                    <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                      可以回放本轮固定世界轨迹，或导出原始数据。
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>

          {!lockedView && (
            <div className="mt-3 flex items-center justify-between gap-3 font-mono text-[8px] uppercase tracking-[0.06em] text-muted-foreground">
              <span className="flex items-center gap-2 text-plum/70">
                <i className="size-1.5 bg-pink" />
                {mode === 'result' ? 'CAPTURED' : 'CAPTURE IDLE'}
              </span>
              <span>ESC 退出 · 固定世界中心 0° / 0°</span>
            </div>
          )}
        </section>

        {!lockedView && (
          <aside className="order-3 min-w-0 lg:col-span-2 xl:col-span-1">
            <div className={PIXEL_LABEL}>04 / Evidence</div>
            <div className="mt-3 border-y-2 border-plum/25 py-4">
              <span className="font-mono text-[9px] uppercase tracking-[0.08em] text-muted-foreground">
                {trackingMode ? '准星覆盖率' : '命中率'}
              </span>
              <strong className="mt-1 block text-5xl font-black tracking-[-0.07em] text-plum">
                {(metrics.accuracy * 100).toFixed(0)}
                <small className="ml-1 text-base text-pink">%</small>
              </strong>
              <Progress
                className="mt-3 gap-0 [&_[data-slot=progress-indicator]]:bg-pink [&_[data-slot=progress-track]]:h-2 [&_[data-slot=progress-track]]:rounded-none [&_[data-slot=progress-track]]:border [&_[data-slot=progress-track]]:border-plum/20"
                value={metrics.accuracy * 100}
              />
            </div>

            <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1 lg:grid-cols-4 xl:grid-cols-2">
              <Metric
                label={trackingMode ? '命中 / 脱靶 ms' : '命中 / 未中'}
                value={`${metrics.hits} / ${metrics.misses}`}
              />
              <Metric
                label="定位时间"
                value={`${metrics.medianAcquisition.toFixed(0)} ms`}
              />
              <Metric
                label="角度误差"
                value={`${metrics.medianError.toFixed(2)}°`}
              />
              <Metric
                label="路径倍率"
                value={`${metrics.pathEfficiency.toFixed(2)}×`}
              />
            </div>

            <MetricGroup title="帧稳定性" suffix="ms">
              <Metric label="p50" value={metrics.p50.toFixed(1)} />
              <Metric label="p95" value={metrics.p95.toFixed(1)} />
              <Metric label="p99" value={metrics.p99.toFixed(1)} />
              <Metric
                label={`严重抖动 > ${metrics.severeThreshold.toFixed(1)} ms`}
                value={`${(metrics.severeRatio * 100).toFixed(1)}%`}
              />
            </MetricGroup>

            <MetricGroup title="输入健康">
              <Metric
                label="事件速率"
                value={`${metrics.inputHz.toFixed(0)} Hz`}
              />
              <Metric
                label="渲染节奏"
                value={`${metrics.fps.toFixed(0)} FPS`}
              />
              <Metric label="Long tasks" value={String(metrics.longTasks)} />
            </MetricGroup>

            {error && (
              <div
                className="mt-4 border-2 border-rose-400 bg-rose-50 p-3 font-mono text-[10px] leading-relaxed text-rose-700"
                role="alert"
              >
                {error}
              </div>
            )}

            <div className="mt-4 grid grid-cols-3 gap-2">
              <Button
                className="rounded-none border-2 border-plum/35 bg-white font-mono text-[9px] text-plum hover:bg-pink-soft"
                variant="outline"
                size="sm"
                onClick={replay}
                disabled={!run}
              >
                <RotateCcw size={14} /> 回放
              </Button>
              <Button
                className="rounded-none border-2 border-plum/35 bg-white font-mono text-[9px] text-plum hover:bg-pink-soft"
                variant="outline"
                size="sm"
                onClick={exportRun}
                disabled={!run}
              >
                <Download size={14} /> 导出
              </Button>
              <Button
                className="rounded-none font-mono text-[9px] text-plum hover:bg-pink-soft"
                variant="ghost"
                size="sm"
                onClick={() => fileRef.current?.click()}
              >
                <Upload size={14} /> 导入
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept="application/json"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) importRun(file);
                  event.currentTarget.value = '';
                }}
              />
            </div>

            {mode === 'result' && run && (
              <Suspense
                fallback={
                  <div className="mt-5 h-36 animate-pulse border-2 border-plum/20 bg-white/50" />
                }
              >
                <ResultEvidence
                  run={run}
                  history={history}
                  compareId={compareId}
                  setCompareId={setCompareId}
                  comparison={comparison}
                />
              </Suspense>
            )}
          </aside>
        )}
      </section>

      {!lockedView && (
        <footer className="mx-auto flex max-w-[1720px] flex-col justify-between gap-2 border-t border-plum/15 px-4 py-5 font-mono text-[8px] uppercase tracking-[0.08em] text-muted-foreground sm:flex-row sm:px-6">
          <span>LOCAL ONLY · FIXED WORLD · TRANSPARENT A/B VERDICT</span>
          <span>SCHEMA 2.0 / RAW SESSION EVIDENCE</span>
        </footer>
      )}
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-plum/15 py-2 font-mono text-[10px]">
      <span className="text-muted-foreground">{label}</span>
      <strong className="text-right text-foreground tabular-nums">
        {value}
      </strong>
    </div>
  );
}

function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label
        className="flex justify-between font-mono text-[9px] font-medium text-plum/75"
        htmlFor={htmlFor}
      >
        {label}
        {hint && (
          <span className="font-normal text-muted-foreground">{hint}</span>
        )}
      </Label>
      {children}
    </div>
  );
}

function ContractRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <span className="text-muted-foreground">{label}</span>
      <b className="text-right font-semibold text-plum">{value}</b>
    </div>
  );
}

function MetricGroup({
  title,
  suffix,
  children,
}: {
  title: string;
  suffix?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-5 border-2 border-plum/25 bg-white/55 p-3">
      <div className="mb-1 flex items-center justify-between font-pixel text-[8px] uppercase text-plum">
        <span>{title}</span>
        {suffix && (
          <span className="font-mono text-[8px] text-muted-foreground">
            {suffix}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}
