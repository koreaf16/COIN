'use client';

import { useEffect, useState } from 'react';

interface Plan {
  id: number;
  symbol: string;
  direction: string;
  entry_conditions: any;
  target_price: number;
  stop_price: number;
  stop_conditions: any;
  time_stop_min: number;
  confidence: number;
  reasoning: string;
  scenario_id: string;
  status: string;
  created_at: string;
  valid_until: string;
  triggered_at: string;
}

const parseJson = (val: any) => {
  if (!val) return null;
  if (typeof val === 'string') { try { return JSON.parse(val); } catch { return val; } }
  return val;
};

export function PlanDetailCard({ planId }: { planId: number | null }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!planId) { setPlan(null); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/coin/plans/${planId}`)
      .then(r => { if (!r.ok) throw new Error('not found'); return r.json(); })
      .then(data => { if (!cancelled) setPlan(Array.isArray(data) ? data[0] : data); })
      .catch(() => { if (!cancelled) setError('시나리오를 불러올 수 없습니다.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [planId]);

  if (!planId) {
    return (
      <div className="h-full flex items-center justify-center text-outline text-sm">
        <div className="text-center">
          <span className="material-symbols-outlined text-3xl block mb-2">description_off</span>
          연결된 시나리오 없음
        </div>
      </div>
    );
  }

  if (loading) return <div className="h-full flex items-center justify-center text-outline text-sm">로딩 중...</div>;
  if (error || !plan) return <div className="h-full flex items-center justify-center text-error text-sm">{error || '데이터 없음'}</div>;

  const entryConditions = parseJson(plan.entry_conditions);
  const stopConditions = parseJson(plan.stop_conditions);

  return (
    <div className="h-full overflow-y-auto space-y-4">
      {/* 헤더 */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${plan.direction === 'LONG' ? 'bg-success/10 text-success' : 'bg-error/10 text-error'}`}>
          {plan.direction}
        </span>
        <span className="text-outline text-xs">Plan #{plan.id}</span>
        <span className={`px-2 py-0.5 rounded text-[9px] font-bold ${
          plan.status === 'ACTIVE' ? 'bg-success/10 text-success' :
          plan.status === 'TRIGGERED' ? 'bg-primary/10 text-primary' :
          plan.status === 'FAILED' ? 'bg-error/10 text-error' :
          'bg-surface-variant text-outline'
        }`}>{plan.status}</span>
        <span className="text-outline text-[10px]">
          확신도 {((plan.confidence || 0) * 100).toFixed(0)}%
        </span>
      </div>

      {/* 가격 정보 */}
      <div className="grid grid-cols-3 gap-2">
        <InfoBox label="목표가" value={plan.target_price ? `$${Number(plan.target_price).toLocaleString()}` : '--'} />
        <InfoBox label="손절가" value={plan.stop_price ? `$${Number(plan.stop_price).toLocaleString()}` : '--'} />
        <InfoBox label="시간 손절" value={plan.time_stop_min ? `${plan.time_stop_min}분` : '--'} />
      </div>

      {/* 진입 조건 */}
      {entryConditions && (
        <div>
          <h4 className="font-headline font-bold text-[10px] uppercase tracking-widest text-outline mb-1.5">진입 조건</h4>
          <div className="bg-surface rounded p-3 space-y-1.5">
            {typeof entryConditions === 'object' && !Array.isArray(entryConditions) ? (
              Object.entries(entryConditions).map(([key, val]: [string, any]) => (
                <div key={key} className="flex justify-between items-center text-xs border-b border-surface-container-high/10 pb-1.5 last:border-0 last:pb-0">
                  <span className="text-on-surface-variant font-label">{key}</span>
                  <ConditionValue condition={val} />
                </div>
              ))
            ) : (
              <pre className="text-[11px] text-on-surface-variant whitespace-pre-wrap">{JSON.stringify(entryConditions, null, 2)}</pre>
            )}
          </div>
        </div>
      )}

      {/* 손절 조건 */}
      {stopConditions && (
        <div>
          <h4 className="font-headline font-bold text-[10px] uppercase tracking-widest text-outline mb-1.5">손절 조건</h4>
          <div className="bg-surface rounded p-3">
            <pre className="text-[11px] text-on-surface-variant whitespace-pre-wrap">{JSON.stringify(stopConditions, null, 2)}</pre>
          </div>
        </div>
      )}

      {/* 시나리오 근거 */}
      {plan.reasoning && (
        <div>
          <h4 className="font-headline font-bold text-[10px] uppercase tracking-widest text-outline mb-1.5">시나리오 근거</h4>
          <div className="bg-surface rounded p-3">
            <p className="text-xs text-on-surface leading-relaxed whitespace-pre-wrap">{plan.reasoning}</p>
          </div>
        </div>
      )}
    </div>
  );
}

function ConditionValue({ condition }: { condition: any }) {
  if (!condition || typeof condition !== 'object') {
    return <span className="font-bold text-xs">{String(condition)}</span>;
  }
  const { op, value, direction, min, max } = condition;
  if (op && value !== undefined) {
    const opLabel: Record<string, string> = { '>': '>', '<': '<', '>=': '≥', '<=': '≤', '==': '=', 'between': '범위' };
    return <span className="font-mono font-bold text-xs">{opLabel[op] || op} {typeof value === 'number' ? value.toLocaleString() : value}</span>;
  }
  if (direction) {
    return <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${direction === 'positive' ? 'bg-success/10 text-success' : direction === 'negative' ? 'bg-error/10 text-error' : 'bg-surface-variant text-outline'}`}>{direction}</span>;
  }
  if (min !== undefined || max !== undefined) {
    return <span className="font-mono font-bold text-xs">{min ?? '*'} ~ {max ?? '*'}</span>;
  }
  return <span className="text-[11px] text-outline">{JSON.stringify(condition)}</span>;
}

function InfoBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface rounded p-2">
      <span className="text-[9px] font-label text-outline uppercase block mb-0.5">{label}</span>
      <span className="text-xs font-bold">{value}</span>
    </div>
  );
}
