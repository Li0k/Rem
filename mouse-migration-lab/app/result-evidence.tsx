import { useMemo } from 'react';
import {
  Activity,
  BarChart3,
  Check,
  CircleHelp,
  Gauge,
  ShieldCheck,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { protocolFor } from './core';
import {
  assessComparison,
  assessRun,
  type ComparisonAssessment,
  type EvidenceQuality,
} from './assessment';
import type { RunData } from './schema';
import {
  diagnoseRun,
  RUN_DIAGNOSTIC_THRESHOLDS,
  type RunDiagnostics,
} from './run-diagnostics';
import {
  medianTiming,
  supportsAttemptTiming,
  timingModelForRun,
} from './timing';

type Comparison = {
  other: RunData;
  compatibility: { compatible: boolean; reasons: string[] };
  deltas: {
    accuracyPct: number;
    medianErrorPct: number;
    medianAcquisitionPct: number;
    pathEfficiencyPct: number;
  } | null;
} | null;

export default function ResultEvidence({
  run,
  history,
  compareId,
  setCompareId,
  comparison,
}: {
  run: RunData;
  history: RunData[];
  compareId: string;
  setCompareId: (value: string) => void;
  comparison: Comparison;
}) {
  const movement = run.movement.t
    .map((t, index) => ({ t, index }))
    .filter(
      ({ index }) =>
        index % Math.max(1, Math.floor(run.movement.t.length / 80)) === 0,
    )
    .map(({ t, index }) => ({
      time: Math.round(t / 100) / 10,
      yaw: run.movement.yaw[index] ?? 0,
      pitch: run.movement.pitch[index] ?? 0,
    }));
  const device = run.settings.device;
  const candidates = history.filter((item) => item.createdAt !== run.createdAt);
  const quality = assessRun(run);
  const motionDiagnosis = useMemo(() => diagnoseRun(run), [run]);
  const timingModel = timingModelForRun(run);
  const hasAttemptTiming = supportsAttemptTiming(timingModel);
  const reactionMedian = medianTiming(run.clicks, 'reactionTime');
  const movementMedian = medianTiming(run.clicks, 'movementTime');
  const completionMedian = medianTiming(run.clicks, 'completionTime');
  const comparisonAssessment = comparison
    ? assessComparison(run, comparison.other)
    : null;

  return (
    <div className="mt-5 space-y-4 border-t-2 border-plum/20 pt-5">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 font-pixel text-[8px] uppercase tracking-[0.08em] text-plum">
          <BarChart3 className="size-3.5" /> Run evidence
        </span>
        <span className="font-mono text-[9px] text-muted-foreground">
          {new Date(run.createdAt).toLocaleString('zh-CN')}
        </span>
      </div>

      <MotionDiagnosisPanel diagnosis={motionDiagnosis} />

      <div className="grid gap-2 sm:grid-cols-2">
        <EvidenceCell
          label="Device"
          value={device?.name ?? 'Imported run'}
          detail={`${device?.mouse ?? '—'} · ${device?.dpi ?? '—'} DPI`}
        />
        <EvidenceCell
          label="Contract"
          value={protocolFor(run.settings.testMode).name}
          detail={`${run.settings.duration}s · ${run.settings.fov}° H-FOV · ${run.settings.degreesPerCount.toFixed(4)}°/unit · seed ${run.settings.seed}`}
        />
        <EvidenceCell
          label="反应 / 选球"
          value={
            hasAttemptTiming
              ? `${reactionMedian?.toFixed(0) ?? '—'} ms`
              : timingModel === 'legacy-response'
                ? `${run.metrics.medianAcquisition.toFixed(0)} ms`
                : '—'
          }
          detail={
            hasAttemptTiming
              ? '本次 attempt anchor → 有效移动起手'
              : timingModel === 'legacy-response'
                ? 'legacy：目标出现/刷新 → 点击'
                : '旧 dual-v1：不可与新计时混用'
          }
        />
        <EvidenceCell
          label="移动时间"
          value={
            hasAttemptTiming ? `${movementMedian?.toFixed(0) ?? '—'} ms` : '—'
          }
          detail={
            hasAttemptTiming
              ? '有效移动起手 → 命中；deadband + idle gap'
              : '旧数据未记录 movement onset'
          }
        />
        <EvidenceCell
          label="单次完成"
          value={
            hasAttemptTiming
              ? `${completionMedian?.toFixed(0) ?? '—'} ms`
              : timingModel === 'legacy-response'
                ? `${run.metrics.medianAcquisition.toFixed(0)} ms`
                : '—'
          }
          detail={
            hasAttemptTiming
              ? 'attempt anchor → 命中；反应 + 移动 ≈ 完成'
              : 'legacy acquisition；仅同语义 run 可比较'
          }
        />
        {run.settings.inputBackend?.diagnostics && (
          <EvidenceCell
            label="Input diagnostics"
            value={`${run.settings.inputBackend.diagnostics.backend} · ${run.settings.inputBackend.diagnostics.native ? 'native' : 'browser'}`}
            detail={`packets ${run.settings.inputBackend.diagnostics.packetCount} · events ${run.settings.inputBackend.diagnostics.eventCount} · move/button ${run.settings.inputBackend.diagnostics.movementPackets}/${run.settings.inputBackend.diagnostics.buttonEvents} · ${run.settings.inputBackend.diagnostics.packetHz?.toFixed(0) ?? '—'} Hz · devices ${run.settings.inputBackend.diagnostics.deviceCount} · peak ${run.settings.inputBackend.diagnostics.peakPending}/${run.settings.inputBackend.diagnostics.capacity || 'n/a'} · pending ${run.settings.inputBackend.diagnostics.currentPending} · dropped ${run.settings.inputBackend.diagnostics.dropped} · event t ${run.settings.inputBackend.diagnostics.firstEventMs?.toFixed(1) ?? '—'}–${run.settings.inputBackend.diagnostics.lastEventMs?.toFixed(1) ?? '—'} ms${run.settings.inputBackend.diagnostics.fallbackReason && run.settings.inputBackend.diagnostics.fallbackReason !== 'not-applicable' ? ` · fallback ${run.settings.inputBackend.diagnostics.fallbackReason}` : ''}`}
          />
        )}
      </div>

      <QualityPanel quality={quality} />

      <div className="border-2 border-plum/60 bg-white/75 p-3 shadow-[3px_3px_0_0_var(--color-pink-soft)]">
        <div className="mb-2 flex items-center justify-between gap-2 font-mono text-[9px] uppercase tracking-[0.08em] text-muted-foreground">
          <span>Angular path</span>
          <small>yaw / pitch · degrees</small>
        </div>
        {movement.length > 1 ? (
          <ResponsiveContainer width="100%" height={142}>
            <AreaChart
              data={movement}
              margin={{ top: 8, right: 0, left: -28, bottom: 0 }}
            >
              <defs>
                <linearGradient id="yawFill" x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="0%"
                    stopColor="var(--color-pink)"
                    stopOpacity={0.28}
                  />
                  <stop
                    offset="100%"
                    stopColor="var(--color-pink)"
                    stopOpacity={0}
                  />
                </linearGradient>
              </defs>
              <CartesianGrid
                stroke="var(--color-pink-soft)"
                strokeDasharray="2 3"
                vertical={false}
              />
              <XAxis
                dataKey="time"
                tick={{ fill: 'var(--color-muted-foreground)', fontSize: 9 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tick={{ fill: 'var(--color-muted-foreground)', fontSize: 9 }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                contentStyle={{
                  background: 'var(--color-card)',
                  border: '2px solid var(--color-plum)',
                  borderRadius: 0,
                  fontSize: 10,
                  color: 'var(--color-foreground)',
                }}
              />
              <Area
                type="monotone"
                dataKey="yaw"
                stroke="var(--color-pink)"
                fill="url(#yawFill)"
                strokeWidth={1.5}
                dot={false}
              />
              <Area
                type="monotone"
                dataKey="pitch"
                stroke="var(--color-indigo)"
                fill="none"
                strokeWidth={1.15}
                dot={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="grid h-36 place-items-center font-mono text-xs text-muted-foreground">
            本轮没有移动事件
          </div>
        )}
      </div>

      <div className="border-2 border-plum/35 bg-pink-soft/25 p-3">
        <div className="mb-3 flex items-center justify-between font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-plum">
          <span className="flex items-center gap-2">
            <Gauge className="size-3.5" /> Compare a second run
          </span>
          <CircleHelp className="size-3.5 text-muted-foreground" />
        </div>
        <select
          className="h-9 w-full border-2 border-plum/60 bg-white px-2 font-mono text-[10px] text-foreground outline-none transition focus:border-pink focus:ring-2 focus:ring-pink/20"
          value={compareId}
          onChange={(event) => setCompareId(event.target.value)}
        >
          <option value="">选择另一轮 session…</option>
          {candidates.map((item) => (
            <option key={item.createdAt} value={item.createdAt}>
              {item.settings.device?.name ?? 'Imported'} ·{' '}
              {protocolFor(item.settings.testMode).name} ·{' '}
              {new Date(item.createdAt).toLocaleDateString('zh-CN')}
            </option>
          ))}
        </select>

        {comparison && (
          <div
            className={`mt-3 border-2 p-3 ${
              comparison.compatibility.compatible
                ? 'border-plum/45 bg-white/80'
                : 'border-rose-400 bg-rose-50'
            }`}
          >
            {comparison.compatibility.compatible ? (
              <>
                <div className="mb-3 flex items-center gap-2 font-pixel text-[7px] uppercase text-plum">
                  <Check className="size-3.5 text-pink" /> Compatible ·{' '}
                  {comparison.other.settings.device?.name ?? 'second run'}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Delta
                    label="准确率"
                    value={comparison.deltas?.accuracyPct ?? 0}
                  />
                  <Delta
                    label="角度误差"
                    value={comparison.deltas?.medianErrorPct ?? 0}
                    inverse
                  />
                  <Delta
                    label="单次完成"
                    value={comparison.deltas?.medianAcquisitionPct ?? 0}
                    inverse
                  />
                  <Delta
                    label="路径倍率"
                    value={comparison.deltas?.pathEfficiencyPct ?? 0}
                    inverse
                  />
                </div>
                {comparisonAssessment && (
                  <ComparisonAssessmentPanel
                    assessment={comparisonAssessment}
                  />
                )}
              </>
            ) : (
              <div className="flex items-start gap-2 font-mono text-[10px] leading-relaxed text-rose-700">
                <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
                Non-comparable · {comparison.compatibility.reasons.join('、')}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function MotionDiagnosisPanel({ diagnosis }: { diagnosis: RunDiagnostics }) {
  if (
    diagnosis.status === 'not-applicable' ||
    diagnosis.status === 'insufficient'
  )
    return (
      <div className="border-2 border-plum/40 bg-white/75 p-4">
        <div className="flex items-center gap-2 font-pixel text-[8px] uppercase text-plum">
          <Activity className="size-3.5" /> 这轮你怎么打的
        </div>
        <p className="mt-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
          {diagnosis.note}
        </p>
      </div>
    );

  const overRate = diagnosis.overshoot.rate ?? 0;
  const underRate = diagnosis.undershoot.rate ?? 0;
  const enough = diagnosis.analyzedAttempts >= 3;
  const tendency = !enough
    ? '样本还少，先把下面的数据当作单轮观察'
    : overRate - underRate >= 0.1
      ? '本轮更偏过冲：准心越过目标圈后又拉了回来'
      : underRate - overRate >= 0.1
        ? '本轮更偏欠冲：点击时准心经常还没走够'
        : '本轮没有明显的单边过冲或欠冲倾向';
  const correctionText =
    diagnosis.corrections.median === null
      ? '—'
      : `${diagnosis.corrections.median.toFixed(0)} 次`;
  const pauseText =
    diagnosis.pause.medianMs === null
      ? '—'
      : `${diagnosis.pause.medianMs.toFixed(0)} ms`;
  const arrivalText =
    diagnosis.arrival.medianMs === null
      ? '—'
      : `${diagnosis.arrival.medianMs.toFixed(0)} ms`;

  return (
    <div className="border-2 border-plum/60 bg-pink-soft/30 p-4 shadow-[4px_4px_0_0_var(--color-pink-soft)]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 font-pixel text-[8px] uppercase text-plum">
          <Activity className="size-3.5" /> 这轮你怎么打的
        </span>
        <span className="font-mono text-[9px] text-muted-foreground">
          已分析 {diagnosis.analyzedAttempts}/{diagnosis.attempts} 次点击
        </span>
      </div>
      <p className="mt-3 border-l-2 border-pink pl-3 font-mono text-[12px] font-semibold leading-relaxed text-plum">
        {tendency}
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <HumanMetric
          label="明显过冲"
          value={`${diagnosis.overshoot.count}/${diagnosis.analyzedAttempts}`}
          detail={
            diagnosis.overshoot.median === null
              ? '没有越过目标圈'
              : `中位多走 ${diagnosis.overshoot.median.toFixed(2)}°`
          }
        />
        <HumanMetric
          label="明显欠冲"
          value={`${diagnosis.undershoot.count}/${diagnosis.analyzedAttempts}`}
          detail={
            diagnosis.undershoot.median === null
              ? '没有明显少走'
              : `中位少走 ${diagnosis.undershoot.median.toFixed(2)}°`
          }
        />
        <HumanMetric
          label="二次修正"
          value={correctionText}
          detail={
            diagnosis.corrections.p75 === null
              ? '静态目标才会判定'
              : `P75 ${diagnosis.corrections.p75.toFixed(0)} 次`
          }
        />
        <HumanMetric
          label="首次进圈"
          value={arrivalText}
          detail={`${diagnosis.arrival.sampled}/${diagnosis.analyzedAttempts} 次有轨迹证据`}
        />
        <HumanMetric
          label="点击前停顿"
          value={pauseText}
          detail={
            diagnosis.pause.overThresholdRate === null
              ? '没有足够样本'
              : `>${RUN_DIAGNOSTIC_THRESHOLDS.pauseMs}ms 占 ${(diagnosis.pause.overThresholdRate * 100).toFixed(0)}%`
          }
        />
      </div>
      <p className="mt-3 font-mono text-[8px] leading-relaxed text-muted-foreground">
        {diagnosis.note}
        。单轮倾向不能直接证明灵敏度过高或过低；换鼠标时应比较相同协议的多轮结果。
      </p>
    </div>
  );
}

function HumanMetric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="border-2 border-plum/35 bg-white/85 p-3">
      <span className="font-mono text-[9px] text-muted-foreground">
        {label}
      </span>
      <strong className="mt-1 block font-mono text-lg text-plum">
        {value}
      </strong>
      <small className="mt-1 block font-mono text-[8px] leading-relaxed text-muted-foreground">
        {detail}
      </small>
    </div>
  );
}

function QualityPanel({ quality }: { quality: EvidenceQuality }) {
  const status = quality.hardInvalid.length
    ? 'INVALID'
    : quality.warnings.length
      ? 'REVIEW NEEDED'
      : 'EVIDENCE READY';
  const statusClass = quality.hardInvalid.length
    ? 'border-rose-400 bg-rose-50 text-rose-700'
    : quality.warnings.length
      ? 'border-amber-400 bg-amber-50 text-amber-800'
      : 'border-emerald-500 bg-emerald-50 text-emerald-800';
  return (
    <div className={`border-2 p-3 ${statusClass}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-pixel text-[8px] uppercase tracking-[0.08em]">
          Evidence assessment
        </span>
        <b className="font-mono text-[9px]">{status}</b>
      </div>
      <div className="mt-2 grid gap-1 font-mono text-[9px] sm:grid-cols-2">
        <span>完成度：{quality.completed ? '通过' : '不足'}</span>
        <span>输入事件：{quality.inputEvents}</span>
        <span>输入丢包：{quality.inputDropped}</span>
        <span>
          Native packets：{quality.nativeInput ? quality.nativePackets : 'n/a'}
        </span>
        <span>
          输入设备：{quality.nativeInput ? quality.inputDeviceCount : 'n/a'}
        </span>
        {quality.clickSamples > 0 && (
          <span>点击样本：{quality.clickSamples}</span>
        )}
        {quality.clickSamples > 0 && (
          <span>命中样本：{quality.hitSamples}</span>
        )}
        {quality.trackingEffectiveMs > 0 && (
          <span>
            跟枪有效：{(quality.trackingEffectiveMs / 1000).toFixed(1)}s
          </span>
        )}
        <span>帧样本：{quality.frameSamples}</span>
        <span>严重帧：{(quality.severeRatio * 100).toFixed(1)}%</span>
        <span>Long task：{quality.longTasks}</span>
      </div>
      {quality.hardInvalid.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-4 font-mono text-[9px]">
          {quality.hardInvalid.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
      {quality.warnings.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-4 font-mono text-[9px]">
          {quality.warnings.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
      <p className="mt-2 font-mono text-[8px] leading-relaxed opacity-80">
        这是运行证据质量门槛，不代表统计置信度或“最优”灵敏度。
      </p>
    </div>
  );
}

function ComparisonAssessmentPanel({
  assessment,
}: {
  assessment: ComparisonAssessment;
}) {
  const overallLabel = {
    better: '整体更好',
    worse: '整体更差',
    mixed: '指标分歧',
    inconclusive: '证据不足',
  }[assessment.overall];
  const verdictColor = {
    improved: 'text-emerald-700',
    regressed: 'text-rose-600',
    neutral: 'text-muted-foreground',
  } as const;
  return (
    <div className="mt-3 border-t border-plum/20 pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2 font-pixel text-[7px] uppercase text-plum">
        <span>Transparent verdict · {overallLabel}</span>
        <span className="font-mono text-[9px] normal-case text-muted-foreground">
          +{assessment.improved} / −{assessment.regressed} / =
          {assessment.neutral}
        </span>
      </div>
      <div className="mt-2 space-y-1 font-mono text-[9px]">
        {assessment.metrics.map((metric) => (
          <div
            className="flex items-center justify-between gap-2 border-b border-plum/10 py-1"
            key={metric.key}
          >
            <span className="text-muted-foreground">{metric.label}</span>
            <span className={verdictColor[metric.verdict]}>
              {formatMetric(metric.key, metric.candidate)} (
              {metric.delta > 0 ? '+' : ''}
              {formatMetricDelta(metric.key, metric.delta)}) · {metric.verdict}
            </span>
          </div>
        ))}
      </div>
      {(!assessment.baseQuality.minimumQuality ||
        !assessment.candidateQuality.minimumQuality) && (
        <div className="mt-2 border-l-2 border-amber-400 pl-2 font-mono text-[9px] leading-relaxed text-amber-800">
          <div>
            本轮证据：{qualityStatus(assessment.baseQuality)}；对照证据：
            {qualityStatus(assessment.candidateQuality)}
          </div>
          {[
            ...assessment.baseQuality.hardInvalid,
            ...assessment.baseQuality.warnings,
          ].map((item) => (
            <div key={`base-${item}`}>本轮：{item}</div>
          ))}
          {[
            ...assessment.candidateQuality.hardInvalid,
            ...assessment.candidateQuality.warnings,
          ].map((item) => (
            <div key={`candidate-${item}`}>对照：{item}</div>
          ))}
        </div>
      )}
      {assessment.recommendation && (
        <p className="mt-3 border-l-2 border-pink pl-2 font-mono text-[10px] font-semibold leading-relaxed text-plum">
          {assessment.recommendation}。
        </p>
      )}
      {!assessment.recommendation && assessment.overall === 'inconclusive' && (
        <p className="mt-3 font-mono text-[9px] leading-relaxed text-muted-foreground">
          仅报告逐项变化；两轮必须满足证据门槛、灵敏度确实不同且无指标分歧，才会给出保守方向。
        </p>
      )}
    </div>
  );
}

function qualityStatus(quality: EvidenceQuality) {
  if (quality.hardInvalid.length > 0) return 'INVALID';
  if (quality.warnings.length > 0) return 'REVIEW NEEDED';
  return 'READY';
}

function formatMetric(
  key: ComparisonAssessment['metrics'][number]['key'],
  value: number,
) {
  if (key === 'accuracy') return `${(value * 100).toFixed(1)}%`;
  if (key === 'medianError') return `${value.toFixed(2)}°`;
  if (key === 'medianAcquisition') return `${value.toFixed(0)}ms`;
  return `${value.toFixed(2)}x`;
}

function formatMetricDelta(
  key: ComparisonAssessment['metrics'][number]['key'],
  value: number,
) {
  if (key === 'accuracy') return `${(value * 100).toFixed(1)}pp`;
  if (key === 'medianError') return `${value.toFixed(2)}°`;
  if (key === 'medianAcquisition') return `${value.toFixed(0)}ms`;
  return `${value.toFixed(2)}x`;
}

function EvidenceCell({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="border border-plum/25 bg-white/60 p-3">
      <span className="font-pixel text-[7px] uppercase text-muted-foreground">
        {label}
      </span>
      <b className="mt-1 block text-xs text-foreground">{value}</b>
      <small className="mt-1 block font-mono text-[9px] text-muted-foreground">
        {detail}
      </small>
    </div>
  );
}

function Delta({
  label,
  value,
  inverse = false,
}: {
  label: string;
  value: number;
  inverse?: boolean;
}) {
  const positive = inverse ? value < 0 : value > 0;
  return (
    <div className="flex items-center justify-between border-b border-plum/15 py-1.5 font-mono text-[10px]">
      <span className="text-muted-foreground">{label}</span>
      <b
        className={
          positive
            ? 'text-emerald-700'
            : value === 0
              ? 'text-foreground'
              : 'text-rose-600'
        }
      >
        {value > 0 ? '+' : ''}
        {(value * 100).toFixed(1)}%
      </b>
    </div>
  );
}
