'use client';

import { useEffect, useState } from 'react';

export default function MarketAnalysisPage() {
  const [macro, setMacro] = useState<Record<string, any>>({});
  const [regime, setRegime] = useState('neutral');
  const [states, setStates] = useState<any[]>([]);

  useEffect(() => {
    const fetchMacro = async () => {
      try {
        const res = await fetch('/api/coin/macro');
        if (res.ok) {
          const data = await res.json();
          setMacro(data);
          setRegime(data.regime || 'neutral');
        }
      } catch {}
    };
    const fetchStates = async () => {
      try {
        const res = await fetch('/api/coin/market-states/BTCUSDT');
        if (res.ok) setStates(await res.json());
      } catch {}
    };
    fetchMacro();
    fetchStates();
    const t1 = setInterval(fetchMacro, 60000);
    const t2 = setInterval(fetchStates, 120000);
    return () => { clearInterval(t1); clearInterval(t2); };
  }, []);

  const regimeLabel = regime === 'risk_on' ? 'RISK-ON' : regime === 'risk_off' ? 'RISK-OFF' : 'NEUTRAL';
  const regimeColor = regime === 'risk_on' ? 'bg-success/10 text-success' : regime === 'risk_off' ? 'bg-error/10 text-error' : 'bg-surface-variant text-outline';

  return (
    <div className="p-6 space-y-6">
      {/* 레짐 요약 */}
      <div className="bg-surface-container-lowest p-6 rounded shadow-sm flex gap-6 items-start">
        <span className="material-symbols-outlined text-3xl text-primary mt-1">public</span>
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-3">
            <h2 className="font-headline font-bold text-xl">레짐 요약</h2>
            <span className={`px-2 py-0.5 text-[10px] font-bold rounded font-label ${regimeColor}`}>{regimeLabel}</span>
          </div>
          <p className="text-sm text-on-surface-variant leading-relaxed">
            DXY, VIX, US10Y, NQ 선물 데이터를 기반으로 매크로 레짐을 자동 분류합니다.
            LLM 시나리오 생성 시 이 레짐이 환경 조건(조건1)으로 사용됩니다.
          </p>
        </div>
      </div>

      {/* 매크로 지표 카드 */}
      <div className="grid grid-cols-4 gap-4">
        <MacroCard label="DXY 지수" value={macro.DXY?.value?.toFixed(2) || '--'} ts={macro.DXY?.ts} />
        <MacroCard label="VIX" value={macro.VIX?.value?.toFixed(2) || '--'} ts={macro.VIX?.ts} />
        <MacroCard label="US 10년물 금리" value={macro.US10Y?.value ? `${macro.US10Y.value.toFixed(3)}%` : '--'} ts={macro.US10Y?.ts} />
        <MacroCard label="NQ 선물" value={macro.NQ_FUTURE?.value?.toLocaleString() || '--'} ts={macro.NQ_FUTURE?.ts} />
      </div>

      {/* 시장 상태 벡터 히스토리 */}
      <div className="bg-surface-container-lowest rounded shadow-sm overflow-hidden">
        <div className="p-4 border-b border-surface-container-high/30">
          <h3 className="font-headline font-bold text-sm">시장 상태 벡터 히스토리 <span className="text-outline font-normal text-xs">(BTCUSDT, 최근 50개)</span></h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left font-label">
            <thead>
              <tr className="text-[10px] text-outline uppercase border-b border-surface-container-high/30">
                <th className="p-3 font-semibold">시각</th>
                <th className="p-3 font-semibold">변동성</th>
                <th className="p-3 font-semibold">추세</th>
                <th className="p-3 font-semibold">펀딩비 Z</th>
                <th className="p-3 font-semibold">OI 변화</th>
                <th className="p-3 font-semibold">CVD</th>
                <th className="p-3 font-semibold">매크로</th>
                <th className="p-3 font-semibold">센티먼트</th>
                <th className="p-3 font-semibold">청산 비대칭</th>
              </tr>
            </thead>
            <tbody className="text-[11px]">
              {states.length === 0 ? (
                <tr><td colSpan={9} className="p-4 text-center text-outline">데이터 축적 중 (매 시간 생성)...</td></tr>
              ) : states.map((s, i) => (
                <tr key={i} className="border-b border-surface-container-high/10 hover:bg-surface">
                  <td className="p-3 text-outline">{s.ts ? new Date(s.ts).toLocaleString('ko-KR', { timeZone: 'America/New_York', hour12: false, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '--'}</td>
                  <td className="p-3"><span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${s.volatility_regime === 'HIGH' ? 'bg-error/10 text-error' : s.volatility_regime === 'LOW' ? 'bg-success/10 text-success' : 'bg-surface-variant text-outline'}`}>{s.volatility_regime || '--'}</span></td>
                  <td className={`p-3 font-bold ${(s.trend_strength || 0) > 0 ? 'text-success' : (s.trend_strength || 0) < 0 ? 'text-error' : ''}`}>{s.trend_strength?.toFixed(2) || '--'}</td>
                  <td className={`p-3 ${(s.funding_zscore || 0) > 1 ? 'text-error' : (s.funding_zscore || 0) < -1 ? 'text-success' : ''}`}>{s.funding_zscore?.toFixed(2) || '--'}</td>
                  <td className={`p-3 ${(s.oi_change_pct || 0) > 0 ? 'text-success' : 'text-error'}`}>{s.oi_change_pct?.toFixed(2) || '--'}%</td>
                  <td className={`p-3 ${(s.cvd_direction || 0) > 0 ? 'text-success' : 'text-error'}`}>{s.cvd_direction?.toFixed(2) || '--'}</td>
                  <td className="p-3"><span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${s.macro_regime === 'risk_on' ? 'bg-success/10 text-success' : s.macro_regime === 'risk_off' ? 'bg-error/10 text-error' : 'bg-surface-variant text-outline'}`}>{s.macro_regime?.toUpperCase().replace('_', '-') || '--'}</span></td>
                  <td className="p-3">{s.sentiment_score?.toFixed(2) || '0'}</td>
                  <td className={`p-3 ${(s.liq_asymmetry || 0) > 0 ? 'text-success' : 'text-error'}`}>{s.liq_asymmetry?.toFixed(2) || '--'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function MacroCard({ label, value, ts }: { label: string; value: string; ts?: string }) {
  return (
    <div className="bg-surface-container-lowest p-5 rounded shadow-sm">
      <span className="text-[10px] font-label text-outline uppercase tracking-wider block mb-1">{label}</span>
      <span className="text-2xl font-bold font-label block">{value}</span>
      {ts && <span className="text-[9px] font-label text-outline">{new Date(ts).toLocaleTimeString('ko-KR', { timeZone: 'America/New_York', hour12: false })}</span>}
    </div>
  );
}
