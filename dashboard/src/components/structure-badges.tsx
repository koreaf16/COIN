type StructureMonitor = {
  aligned?: boolean;
  blockReason?: string | null;
  current?: {
    daily_bias?: string;
    trend_bias_4h?: string;
    trigger_bias_1h?: string;
  };
  hasHigherTimeframePlan?: boolean;
  hasTriggerPlan?: boolean;
};

function toneForBias(value?: string) {
  if (value === 'BULLISH') return 'bg-success/10 text-success';
  if (value === 'BEARISH') return 'bg-error/10 text-error';
  return 'bg-surface-variant text-outline';
}

function shortBlockReason(reason?: string | null) {
  if (!reason) return null;
  return reason.replace('daily_bias', '1D').replace('trend_bias_4h', '4H');
}

export function StructureBadges({
  structure,
  compact = false,
}: {
  structure?: StructureMonitor | null;
  compact?: boolean;
}) {
  if (!structure) return null;

  const sizeCls = compact ? 'text-[9px] px-1.5 py-0.5' : 'text-[10px] px-2 py-0.5';
  const current = structure.current || {};
  const block = shortBlockReason(structure.blockReason);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span
        className={`rounded font-bold ${sizeCls} ${
          structure.aligned === false ? 'bg-error/10 text-error' : 'bg-success/10 text-success'
        }`}
      >
        {structure.aligned === false ? 'MISALIGN' : 'ALIGN'}
      </span>
      {current.daily_bias ? (
        <span className={`rounded font-bold ${sizeCls} ${toneForBias(current.daily_bias)}`}>
          1D {current.daily_bias}
        </span>
      ) : null}
      {current.trend_bias_4h ? (
        <span className={`rounded font-bold ${sizeCls} ${toneForBias(current.trend_bias_4h)}`}>
          4H {current.trend_bias_4h}
        </span>
      ) : null}
      {current.trigger_bias_1h && !compact ? (
        <span className={`rounded font-bold ${sizeCls} ${toneForBias(current.trigger_bias_1h)}`}>
          1H {current.trigger_bias_1h}
        </span>
      ) : null}
      {structure.hasHigherTimeframePlan === false ? (
        <span className={`rounded font-bold ${sizeCls} bg-surface-variant text-outline`}>
          NO HTF
        </span>
      ) : null}
      {structure.hasTriggerPlan === false ? (
        <span className={`rounded font-bold ${sizeCls} bg-surface-variant text-outline`}>
          NO TRG
        </span>
      ) : null}
      {block ? (
        <span className={`rounded font-bold ${sizeCls} bg-error/10 text-error`}>
          {block}
        </span>
      ) : null}
    </div>
  );
}
