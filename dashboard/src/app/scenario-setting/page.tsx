'use client';

import { useEffect, useState, useCallback } from 'react';

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

export default function ScenarioSettingPage() {
  const [activePlans, setActivePlans] = useState<Plan[]>([]);
  const [triggeredPlans, setTriggeredPlans] = useState<Plan[]>([]);
  const [selectedPlan, setSelectedPlan] = useState<Plan | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const fetchAll = useCallback(async () => {
    try {
      const [active, triggered, failed] = await Promise.all([
        fetch('/api/coin/plans?status=ACTIVE').then(r => r.ok ? r.json() : []),
        fetch('/api/coin/plans?status=TRIGGERED').then(r => r.ok ? r.json() : []),
        fetch('/api/coin/plans?status=FAILED').then(r => r.ok ? r.json() : []),
      ]);
      setActivePlans(active);
      setTriggeredPlans([...triggered, ...failed]);
    } catch {}
  }, []);

  useEffect(() => {
    fetchAll();
    const t = setInterval(fetchAll, 15000);
    return () => clearInterval(t);
  }, [fetchAll]);

  const handlePlanClick = async (planId: number) => {
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/coin/plans/${planId}`);
      if (res.ok) {
        const plan = await res.json();
        setSelectedPlan(plan);
      }
    } catch {} finally {
      setDetailLoading(false);
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="font-headline font-bold text-2xl">시나리오 관리</h1>
        <p className="text-sm text-on-surface-variant mt-1">
          LLM이 10분마다 브리핑→시나리오 연쇄 생성합니다. 룰엔진이 1초마다 조건 대조 후 자동 실행합니다.
        </p>
      </div>

      {/* 요약 카드 */}
      <div className="grid grid-cols-2 gap-4">
        <SummaryCard label="활성 플랜" value={`${activePlans.length}개`} color="text-success" icon="bolt" />
        <SummaryCard label="실행/실패" value={`${triggeredPlans.length}개`} color="text-primary" icon="check_circle" />
      </div>

      {/* 활성 실행 플랜 — 전체 폭 */}
      <div className="bg-surface-container-lowest rounded shadow-sm overflow-hidden">
        <div className="p-4 border-b border-surface-container-high/30 flex justify-between items-center">
          <h3 className="font-headline font-bold text-sm flex items-center gap-2">
            <span className="material-symbols-outlined text-success text-lg">bolt</span>
            활성 실행 플랜
          </h3>
          <button onClick={fetchAll} className="text-[10px] font-label text-primary hover:underline">새로고침</button>
        </div>
        <PlanTable plans={activePlans} showValid onRowClick={handlePlanClick} />
      </div>

      {/* 실행된 플랜 이력 */}
      {triggeredPlans.length > 0 && (
        <div className="bg-surface-container-lowest rounded shadow-sm overflow-hidden">
          <div className="p-4 border-b border-surface-container-high/30">
            <h3 className="font-headline font-bold text-sm flex items-center gap-2">
              <span className="material-symbols-outlined text-primary text-lg">check_circle</span>
              실행된 플랜
            </h3>
          </div>
          <PlanTable plans={triggeredPlans} onRowClick={handlePlanClick} />
        </div>
      )}

      {/* 시스템 설명 */}
      <div className="bg-surface-container-lowest p-5 rounded shadow-sm">
        <div className="flex items-start gap-4">
          <span className="material-symbols-outlined text-2xl text-primary mt-0.5">info</span>
          <div>
            <h3 className="font-headline font-bold text-sm mb-2">시나리오 자동 생성 프로세스</h3>
            <div className="text-sm text-on-surface-variant leading-relaxed space-y-1">
              <p>1. <strong>센티먼트 (1분 주기, DeepSeek)</strong> — 최근 뉴스 헤드라인을 분석하여 시장 감성 점수(-1~+1)를 산출합니다.</p>
              <p>2. <strong>브리핑 → 시나리오 연쇄 (10분 주기, Claude CLI)</strong> — 시장 스냅샷 + 센티먼트 + 유사 과거 사례를 종합하여 브리핑을 생성한 뒤, 즉시 3개 시나리오(진입 조건 JSON + 타겟/손절)를 생성합니다.</p>
              <p>3. <strong>시나리오 컨텍스트:</strong> 경제 캘린더, Fear &amp; Greed 지수, 스테이블코인 공급량이 시나리오 생성에 반영됩니다.</p>
              <p>4. 각 시나리오는 <strong>z2_execution_plan</strong>에 ACTIVE 상태로 저장되며, 유효기간은 <strong>1시간</strong>입니다.</p>
              <p>5. <strong>룰엔진 (1초 주기)</strong> — 활성 플랜의 진입 조건(price, funding_rate, cvd_direction, macro_regime, volume_surge 등)을 실시간 데이터와 대조합니다.</p>
              <p>6. 모든 조건 충족 시 → <strong>Binance Futures 시장가 진입</strong> + 안전망 스탑 설정 → 지능형 청산(타겟/논리무효화/시간손절) 모니터링</p>
              <p>7. <strong>포지션 검증 (5분 주기, DeepSeek)</strong> — 진입 근거가 여전히 유효한지 LLM이 재검증하여 무효 시 청산 권고합니다.</p>
              <p>8. 진입 실패 시 플랜은 자동으로 <strong>FAILED</strong> 상태로 전환됩니다.</p>
            </div>
          </div>
        </div>
      </div>

      {/* 플랜 상세 모달 */}
      {selectedPlan && (
        <PlanDetailModal plan={selectedPlan} onClose={() => setSelectedPlan(null)} loading={detailLoading} />
      )}
    </div>
  );
}

/* ── 플랜 테이블 ── */
function PlanTable({ plans, showValid, onRowClick }: { plans: any[]; showValid?: boolean; onRowClick?: (id: number) => void }) {
  if (plans.length === 0) {
    return (
      <div className="p-8 text-center text-outline">
        <span className="material-symbols-outlined text-3xl opacity-20 block mb-2">inbox</span>
        플랜 없음
      </div>
    );
  }
  return (
    <table className="w-full text-left font-label">
      <thead>
        <tr className="text-[10px] text-outline uppercase border-b border-surface-container-high/30">
          <th className="p-3">ID</th>
          <th className="p-3">심볼</th>
          <th className="p-3">방향</th>
          <th className="p-3">목표가</th>
          <th className="p-3">확신도</th>
          <th className="p-3">근거 요약</th>
          <th className="p-3">생성</th>
          {showValid && <th className="p-3">만료</th>}
          <th className="p-3">상태</th>
        </tr>
      </thead>
      <tbody className="text-sm">
        {plans.map(p => (
          <tr
            key={p.id}
            className="border-b border-surface-container-high/10 hover:bg-surface cursor-pointer transition-colors"
            onClick={() => onRowClick?.(p.id)}
          >
            <td className="p-3 text-outline">#{p.id}</td>
            <td className="p-3 font-bold">{p.symbol}</td>
            <td className="p-3">
              <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${p.direction === 'LONG' ? 'bg-success/10 text-success' : 'bg-error/10 text-error'}`}>{p.direction}</span>
            </td>
            <td className="p-3">{p.target_price ? `$${Number(p.target_price).toLocaleString()}` : '--'}</td>
            <td className="p-3 font-bold">{((p.confidence || 0) * 100).toFixed(0)}%</td>
            <td className="p-3 text-xs text-on-surface-variant max-w-[300px] truncate">
              {typeof p.reasoning === 'string' ? p.reasoning.substring(0, 80) : '--'}
            </td>
            <td className="p-3 text-outline text-xs">{p.created_at ? new Date(p.created_at).toLocaleTimeString('ko-KR', { timeZone: 'America/New_York', hour12: false }) : '--'}</td>
            {showValid && <td className="p-3 text-outline text-xs">{p.valid_until ? new Date(p.valid_until).toLocaleTimeString('ko-KR', { timeZone: 'America/New_York', hour12: false }) : '--'}</td>}
            <td className="p-3">
              <span className={`px-2 py-0.5 rounded text-[9px] font-bold ${
                p.status === 'ACTIVE' ? 'bg-success/10 text-success' :
                p.status === 'TRIGGERED' ? 'bg-primary/10 text-primary' :
                p.status === 'FAILED' ? 'bg-error/10 text-error' :
                'bg-surface-variant text-outline'
              }`}>{p.status}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ── 플랜 상세 모달 ── */
function PlanDetailModal({ plan, onClose, loading }: { plan: Plan; onClose: () => void; loading: boolean }) {
  const parseJson = (val: any) => {
    if (!val) return null;
    if (typeof val === 'string') { try { return JSON.parse(val); } catch { return val; } }
    return val;
  };

  const entryConditions = parseJson(plan.entry_conditions);
  const stopConditions = parseJson(plan.stop_conditions);

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-6" onClick={onClose}>
      <div
        className="bg-surface-container-lowest rounded-lg shadow-xl max-w-2xl w-full max-h-[85vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        {/* 헤더 */}
        <div className="p-5 border-b border-surface-container-high/30 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className={`px-3 py-1 rounded text-xs font-bold ${plan.direction === 'LONG' ? 'bg-success/10 text-success' : 'bg-error/10 text-error'}`}>
              {plan.direction}
            </span>
            <h2 className="font-headline font-bold text-lg">{plan.symbol}</h2>
            <span className="text-outline text-xs">#{plan.id}</span>
            <span className={`px-2 py-0.5 rounded text-[9px] font-bold ${
              plan.status === 'ACTIVE' ? 'bg-success/10 text-success' :
              plan.status === 'TRIGGERED' ? 'bg-primary/10 text-primary' :
              plan.status === 'FAILED' ? 'bg-error/10 text-error' :
              'bg-surface-variant text-outline'
            }`}>{plan.status}</span>
          </div>
          <button onClick={onClose} className="material-symbols-outlined text-outline hover:text-on-surface text-xl">close</button>
        </div>

        {loading ? (
          <div className="p-10 text-center text-outline">로딩 중...</div>
        ) : (
          <div className="p-5 space-y-5">
            {/* 가격 정보 */}
            <div className="grid grid-cols-3 gap-4">
              <InfoBox label="목표가" value={plan.target_price ? `$${Number(plan.target_price).toLocaleString()}` : '--'} />
              <InfoBox label="손절가" value={plan.stop_price ? `$${Number(plan.stop_price).toLocaleString()}` : '--'} />
              <InfoBox label="시간 손절" value={plan.time_stop_min ? `${plan.time_stop_min}분` : '--'} />
            </div>

            <div className="grid grid-cols-3 gap-4">
              <InfoBox label="확신도" value={`${((plan.confidence || 0) * 100).toFixed(0)}%`} />
              <InfoBox
                label="생성 시각"
                value={plan.created_at ? new Date(plan.created_at).toLocaleString('ko-KR', { timeZone: 'America/New_York', hour12: false, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '--'}
              />
              <InfoBox
                label="만료 시각"
                value={plan.valid_until ? new Date(plan.valid_until).toLocaleString('ko-KR', { timeZone: 'America/New_York', hour12: false, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '--'}
              />
            </div>

            {/* 진입 조건 */}
            {entryConditions && (
              <div>
                <h4 className="font-headline font-bold text-xs uppercase tracking-widest text-outline mb-2">진입 조건</h4>
                <div className="bg-surface rounded p-4 space-y-2">
                  {typeof entryConditions === 'object' && !Array.isArray(entryConditions) ? (
                    Object.entries(entryConditions).map(([key, val]: [string, any]) => (
                      <div key={key} className="flex justify-between items-center text-sm border-b border-surface-container-high/10 pb-2 last:border-0 last:pb-0">
                        <span className="text-on-surface-variant font-label">{key}</span>
                        <ConditionValue condition={val} />
                      </div>
                    ))
                  ) : (
                    <pre className="text-xs text-on-surface-variant whitespace-pre-wrap">{JSON.stringify(entryConditions, null, 2)}</pre>
                  )}
                </div>
              </div>
            )}

            {/* 손절 조건 */}
            {stopConditions && (
              <div>
                <h4 className="font-headline font-bold text-xs uppercase tracking-widest text-outline mb-2">손절 조건</h4>
                <div className="bg-surface rounded p-4">
                  <pre className="text-xs text-on-surface-variant whitespace-pre-wrap">{JSON.stringify(stopConditions, null, 2)}</pre>
                </div>
              </div>
            )}

            {/* 근거 (Reasoning) */}
            {plan.reasoning && (
              <div>
                <h4 className="font-headline font-bold text-xs uppercase tracking-widest text-outline mb-2">시나리오 근거</h4>
                <div className="bg-surface rounded p-4">
                  <p className="text-sm text-on-surface leading-relaxed whitespace-pre-wrap">{plan.reasoning}</p>
                </div>
              </div>
            )}

            {/* 실행 정보 */}
            {plan.triggered_at && (
              <div>
                <h4 className="font-headline font-bold text-xs uppercase tracking-widest text-outline mb-2">실행 정보</h4>
                <div className="bg-surface rounded p-4">
                  <span className="text-sm text-on-surface-variant">실행 시각: </span>
                  <span className="text-sm font-bold">
                    {new Date(plan.triggered_at).toLocaleString('ko-KR', { timeZone: 'America/New_York', hour12: false })}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── 조건 값 표시 ── */
function ConditionValue({ condition }: { condition: any }) {
  if (!condition || typeof condition !== 'object') {
    return <span className="font-bold text-sm">{String(condition)}</span>;
  }
  const { op, value, direction, min, max } = condition;
  if (op && value !== undefined) {
    const opLabel: Record<string, string> = { '>': '>', '<': '<', '>=': '≥', '<=': '≤', '==': '=', 'between': '범위' };
    return <span className="font-mono font-bold text-sm">{opLabel[op] || op} {typeof value === 'number' ? value.toLocaleString() : value}</span>;
  }
  if (direction) {
    return <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${direction === 'positive' ? 'bg-success/10 text-success' : direction === 'negative' ? 'bg-error/10 text-error' : 'bg-surface-variant text-outline'}`}>{direction}</span>;
  }
  if (min !== undefined || max !== undefined) {
    return <span className="font-mono font-bold text-sm">{min ?? '*'} ~ {max ?? '*'}</span>;
  }
  return <span className="text-xs text-outline">{JSON.stringify(condition)}</span>;
}

/* ── 정보 박스 ── */
function InfoBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface rounded p-3">
      <span className="text-[10px] font-label text-outline uppercase block mb-1">{label}</span>
      <span className="text-sm font-bold">{value}</span>
    </div>
  );
}

/* ── 요약 카드 ── */
function SummaryCard({ label, value, color, icon }: { label: string; value: string; color: string; icon: string }) {
  return (
    <div className="bg-surface-container-lowest p-5 rounded shadow-sm flex items-center gap-4">
      <span className={`material-symbols-outlined text-2xl ${color}`}>{icon}</span>
      <div>
        <span className="text-[10px] font-label text-outline uppercase block">{label}</span>
        <span className={`text-xl font-bold font-label ${color}`}>{value}</span>
      </div>
    </div>
  );
}
