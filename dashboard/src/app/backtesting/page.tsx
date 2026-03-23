'use client';

import { useEffect, useState } from 'react';
import { TradeReplayChart } from '@/components/trade-replay-chart';
import { PlanDetailCard } from '@/components/plan-detail-card';

/** 가격 표시: 가격대에 맞는 소수점 자릿수 자동 결정 */
const fmtPrice = (price?: number) => {
  if (price == null || isNaN(price)) return '--';
  if (price >= 1000) return price.toFixed(2);
  if (price >= 1)    return price.toFixed(4);
  if (price >= 0.01) return price.toFixed(5);
  return price.toFixed(6);
};

export default function BacktestingPage() {
  const [performance, setPerformance] = useState<any[]>([]);
  const [trades, setTrades] = useState<any[]>([]);
  const [selectedTrade, setSelectedTrade] = useState<any | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [perfRes, posRes] = await Promise.all([
          fetch('/api/coin/performance'),
          fetch('/api/coin/positions?status=CLOSED'),
        ]);
        if (perfRes.ok) setPerformance(await perfRes.json());
        if (posRes.ok) setTrades(await posRes.json());
      } catch {}
    };
    fetchData();
    const t = setInterval(fetchData, 60000);
    return () => clearInterval(t);
  }, []);

  const totalTrades = trades.length;
  const wins = trades.filter(t => (t.pnl_amount || 0) > 0).length;
  const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : '--';
  const totalPnl = trades.reduce((s, t) => s + (t.pnl_amount || 0), 0);

  // Use API-sourced avg_win_pct / avg_loss_pct when available, fall back to client-side calc
  const latestPerf = performance.length > 0 ? performance[0] : null;
  const avgWinPct = latestPerf?.avg_win_pct != null
    ? Number(latestPerf.avg_win_pct).toFixed(2)
    : (() => { const w = trades.filter(t => (t.pnl_pct || 0) > 0); return w.length > 0 ? (w.reduce((s, t) => s + t.pnl_pct, 0) / w.length).toFixed(2) : '--'; })();
  const avgLossPct = latestPerf?.avg_loss_pct != null
    ? Number(latestPerf.avg_loss_pct).toFixed(2)
    : (() => { const l = trades.filter(t => (t.pnl_pct || 0) < 0); return l.length > 0 ? (l.reduce((s, t) => s + t.pnl_pct, 0) / l.length).toFixed(2) : '--'; })();

  // Aggregate sharpe_ratio and profit_factor from most recent performance record
  const sharpeRatio = latestPerf?.sharpe_ratio != null ? Number(latestPerf.sharpe_ratio).toFixed(2) : '--';
  const profitFactor = latestPerf?.profit_factor != null ? Number(latestPerf.profit_factor).toFixed(2) : '--';

  return (
    <div className="p-6 space-y-6">
      <div className="flex justify-between items-start">
        <div>
          <h1 className="font-headline font-bold text-2xl">백테스팅 & 성과 분석</h1>
          <p className="text-sm text-on-surface-variant mt-1">거래 성과를 분석합니다.</p>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-4">
        {/* 성과 요약 */}
        <div className="col-span-8 grid grid-cols-3 gap-4">
          <MetricCard label="총 거래" value={`${totalTrades}`} />
          <MetricCard label="승률" value={`${winRate}%`} color={Number(winRate) > 50 ? 'text-success' : 'text-error'} />
          <MetricCard label="총 손익" value={`$${totalPnl.toFixed(2)}`} color={totalPnl >= 0 ? 'text-success' : 'text-error'} />
          <MetricCard label="평균 승/패" value={`${avgWinPct}% / ${avgLossPct}%`} />
          <MetricCard label="샤프 비율" value={sharpeRatio} color={Number(sharpeRatio) >= 1 ? 'text-success' : Number(sharpeRatio) > 0 ? 'text-on-surface' : 'text-error'} />
          <MetricCard label="수익 팩터" value={profitFactor} color={Number(profitFactor) >= 1 ? 'text-success' : 'text-error'} />
        </div>

        {/* 일간 성과 */}
        <div className="col-span-4 bg-surface-container-lowest p-5 rounded shadow-sm">
          <h3 className="font-headline font-bold text-xs uppercase tracking-widest text-outline mb-3">일간 성과</h3>
          {performance.length === 0 ? (
            <p className="text-xs text-outline">성과 데이터 축적 중...</p>
          ) : (
            <table className="w-full text-left font-label">
              <thead>
                <tr className="text-[9px] text-outline uppercase border-b border-surface-container-high/30">
                  <th className="pb-2 pr-2">일자</th>
                  <th className="pb-2 pr-2 text-right">손익</th>
                  <th className="pb-2 pr-2 text-right">건수</th>
                  <th className="pb-2 pr-2 text-right">샤프</th>
                  <th className="pb-2 text-right">PF</th>
                </tr>
              </thead>
              <tbody>
                {performance.slice(0, 5).map((p, i) => (
                  <tr key={i} className="border-b border-surface-container-high/10 last:border-0">
                    <td className="py-1.5 pr-2 text-outline text-xs">{p.period_start}</td>
                    <td className={`py-1.5 pr-2 text-xs text-right font-bold ${(p.total_pnl || 0) >= 0 ? 'text-success' : 'text-error'}`}>
                      ${p.total_pnl?.toFixed(2) || '0'}
                    </td>
                    <td className="py-1.5 pr-2 text-xs text-right text-on-surface-variant">{p.total_trades || 0}</td>
                    <td className={`py-1.5 pr-2 text-xs text-right font-bold ${(p.sharpe_ratio ?? 0) >= 1 ? 'text-success' : (p.sharpe_ratio ?? 0) > 0 ? 'text-on-surface' : 'text-error'}`}>
                      {p.sharpe_ratio != null ? Number(p.sharpe_ratio).toFixed(2) : '--'}
                    </td>
                    <td className={`py-1.5 text-xs text-right font-bold ${(p.profit_factor ?? 0) >= 1 ? 'text-success' : 'text-error'}`}>
                      {p.profit_factor != null ? Number(p.profit_factor).toFixed(2) : '--'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* 거래 이력 */}
        <div className="col-span-12 bg-surface-container-lowest rounded shadow-sm overflow-hidden">
          <div className="p-4 border-b border-surface-container-high/30">
            <h3 className="font-headline font-bold text-sm">거래 이력</h3>
          </div>
          <table className="w-full text-left font-label">
            <thead>
              <tr className="text-[10px] text-outline uppercase border-b border-surface-container-high/30">
                <th className="p-3">시각</th>
                <th className="p-3">심볼</th>
                <th className="p-3">방향</th>
                <th className="p-3 text-right">진입가</th>
                <th className="p-3 text-right">청산가</th>
                <th className="p-3 text-right">손익</th>
                <th className="p-3">사유</th>
              </tr>
            </thead>
            <tbody className="text-sm">
              {trades.length === 0 ? (
                <tr><td colSpan={7} className="p-6 text-center text-outline">거래 내역이 없습니다.</td></tr>
              ) : trades.slice(0, 20).map((t, i) => (
                <tr
                  key={i}
                  className={`border-b border-surface-container-high/10 hover:bg-surface cursor-pointer transition-colors ${selectedTrade?.id === t.id ? 'bg-primary/5' : ''}`}
                  onClick={() => setSelectedTrade(selectedTrade?.id === t.id ? null : t)}
                >
                  <td className="p-3 text-outline text-xs">{t.entry_time ? new Date(t.entry_time).toLocaleString('ko-KR', { timeZone: 'America/New_York', hour12: false, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '--'}</td>
                  <td className="p-3 font-bold">{t.symbol}</td>
                  <td className="p-3"><span className={`px-2 py-0.5 rounded text-[10px] font-bold ${t.direction === 'LONG' ? 'bg-success/10 text-success' : 'bg-error/10 text-error'}`}>{t.direction}</span></td>
                  <td className="p-3 text-right font-mono">${fmtPrice(t.entry_price)}</td>
                  <td className="p-3 text-right font-mono">{t.exit_price ? `$${fmtPrice(t.exit_price)}` : '--'}</td>
                  <td className={`p-3 text-right font-bold ${(t.pnl_amount || 0) >= 0 ? 'text-success' : 'text-error'}`}>
                    {t.pnl_amount != null ? `${t.pnl_amount >= 0 ? '+' : ''}$${Math.abs(t.pnl_amount).toFixed(2)}` : '--'}
                  </td>
                  <td className="p-3">
                    <div className="flex items-center gap-1">
                      <span className={`px-2 py-0.5 rounded text-[9px] font-bold ${t.exit_reason === 'TARGET' ? 'bg-success/10 text-success' : t.exit_reason === 'SAFETY_STOP' ? 'bg-error/10 text-error' : 'bg-surface-variant text-outline'}`}>{t.exit_reason || '--'}</span>
                      <span className={`material-symbols-outlined text-outline text-sm transition-transform ${selectedTrade?.id === t.id ? 'rotate-180' : ''}`}>expand_more</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* 거래 상세 패널 */}
          {selectedTrade && (
            <div className="border-t border-surface-container-high/30 p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-headline font-bold text-sm flex items-center gap-2">
                  <span className="material-symbols-outlined text-primary text-base">info</span>
                  거래 상세: {selectedTrade.symbol}
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${selectedTrade.direction === 'LONG' ? 'bg-success/10 text-success' : 'bg-error/10 text-error'}`}>
                    {selectedTrade.direction}
                  </span>
                </h3>
                <button onClick={() => setSelectedTrade(null)} className="material-symbols-outlined text-outline hover:text-on-surface text-lg">close</button>
              </div>
              <div className="grid grid-cols-12 gap-4" style={{ minHeight: 400 }}>
                <div className="col-span-7">
                  <TradeReplayChart positionId={selectedTrade.id} onClose={() => setSelectedTrade(null)} />
                </div>
                <div className="col-span-5 bg-surface-container-lowest rounded p-4">
                  <h4 className="font-headline font-bold text-xs uppercase tracking-widest text-outline mb-3">진입 시나리오</h4>
                  <PlanDetailCard planId={selectedTrade.plan_id} />
                </div>
              </div>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}

function MetricCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-surface-container-lowest p-4 rounded shadow-sm">
      <span className="text-[10px] font-label text-outline uppercase block mb-1">{label}</span>
      <span className={`text-xl font-bold font-label ${color || ''}`}>{value}</span>
    </div>
  );
}
