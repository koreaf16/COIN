'use client';

import { useEffect, useState, useCallback } from 'react';
import { Candle1sChart } from '@/components/candle-1s-chart';

/** 가격 표시: 가격대에 맞는 소수점 자릿수 자동 결정 */
const fmtPrice = (price?: number) => {
  if (price == null || isNaN(price)) return '--';
  if (price >= 1000) return price.toFixed(2);
  if (price >= 1)    return price.toFixed(4);
  if (price >= 0.01) return price.toFixed(5);
  return price.toFixed(6);
};

export default function PositionsPage() {
  const [livePositions, setLivePositions] = useState<any[]>([]);
  const [liveTotalPnl, setLiveTotalPnl] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<{ symbol: string; entryPrice: number; direction: string; entryTime?: number; targetPrice?: number; safetyStop?: number } | null>(null);

  const fetchPositions = useCallback(async () => {
    try {
      const res = await fetch('/api/coin/positions/live');
      if (!res.ok) return;
      const data = await res.json();
      setLivePositions(data.positions || []);
      setLiveTotalPnl(data.totalUnrealizedPnl || 0);
    } catch {} finally { setLoading(false); }
  }, []);

  useEffect(() => {
    fetchPositions();
    const t = setInterval(fetchPositions, 5000);
    return () => clearInterval(t);
  }, [fetchPositions]);

  const winCount = livePositions.filter(p => (p.unrealizedPnlUsd || 0) > 0).length;

  const handleSymbolClick = (p: any) => {
    if (selected?.symbol === p.symbol) {
      setSelected(null);
    } else {
      setSelected({
        symbol: p.symbol,
        entryPrice: p.entryPrice,
        direction: p.direction,
        entryTime: p.entryTime ? Math.floor(new Date(p.entryTime).getTime() / 1000) : undefined,
        targetPrice: p.targetPrice || undefined,
        safetyStop: p.safetyStop || undefined,
      });
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="font-headline font-bold text-2xl">포지션</h1>
        <button onClick={fetchPositions}
          className="text-xs font-label text-primary hover:underline">새로고침</button>
      </div>

      <div className="grid grid-cols-4 gap-4">
        <SummaryCard label="미실현 P&L"
          value={`${liveTotalPnl >= 0 ? '+' : ''}$${liveTotalPnl.toFixed(2)}`}
          color={liveTotalPnl >= 0 ? 'text-success' : 'text-error'} />
        <SummaryCard label="오픈 포지션" value={`${livePositions.length}`} color="text-on-surface" />
        <SummaryCard label="수익 / 손실"
          value={`${winCount} / ${livePositions.length - winCount}`}
          color="text-on-surface" />
        <SummaryCard label="상태" value="실시간 모니터링" color="text-primary" />
      </div>

      <div className="bg-surface-container-lowest rounded shadow-sm overflow-hidden">
        {livePositions.length > 0 && (
          <div className="p-4 border-b border-surface-container-high/30 flex items-center justify-between">
            <h3 className="font-headline font-bold text-sm flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-success animate-pulse" />
              실시간 포지션
            </h3>
            <span className={`font-label text-sm font-bold ${liveTotalPnl >= 0 ? 'text-success' : 'text-error'}`}>
              미실현 P&L: {liveTotalPnl >= 0 ? '+' : ''}${liveTotalPnl.toFixed(2)}
            </span>
          </div>
        )}
        <table className="w-full text-left font-label">
          <thead>
            <tr className="text-[10px] text-outline uppercase border-b border-surface-container-high/30">
              <th className="p-3 font-semibold">심볼</th>
              <th className="p-3 font-semibold">방향</th>
              <th className="p-3 font-semibold text-right">진입가</th>
              <th className="p-3 font-semibold text-right">현재가</th>
              <th className="p-3 font-semibold text-right">수량</th>
              <th className="p-3 font-semibold text-right">레버리지</th>
              <th className="p-3 font-semibold text-right">수익률</th>
              <th className="p-3 font-semibold text-right">손익</th>
              <th className="p-3 font-semibold text-right">목표가</th>
              <th className="p-3 font-semibold text-right">손절가</th>
              <th className="p-3 font-semibold text-right">청산가</th>
              <th className="p-3 font-semibold text-right">보유 / 잔여</th>
            </tr>
          </thead>
          <tbody className="text-sm">
            {loading ? (
              <tr><td colSpan={12} className="p-8 text-center text-outline">로딩 중...</td></tr>
            ) : livePositions.length === 0 ? (
              <tr>
                <td colSpan={12} className="p-8 text-center text-outline">
                  <span className="material-symbols-outlined text-3xl opacity-20 block mb-2">inbox</span>
                  오픈 포지션 없음. LLM 시그널 대기 중...
                </td>
              </tr>
            ) : livePositions.map((p: any) => {
              const pnlColor = p.unrealizedPnlUsd >= 0 ? 'text-success' : 'text-error';
              const isSelected = selected?.symbol === p.symbol;
              return (
                <tr key={p.id} className={`border-b border-surface-container-high/10 hover:bg-surface transition-colors cursor-pointer ${isSelected ? 'bg-primary/5' : ''}`}
                    onClick={() => handleSymbolClick(p)}>
                  <td className="p-3 font-bold text-primary hover:underline">
                    <span className="flex items-center gap-1">
                      {p.symbol}
                      <span className={`material-symbols-outlined text-sm transition-transform ${isSelected ? 'rotate-180' : ''}`}>expand_more</span>
                    </span>
                  </td>
                  <td className="p-3">
                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                      p.direction === 'LONG' ? 'bg-success/10 text-success' : 'bg-error/10 text-error'
                    }`}>{p.direction}</span>
                  </td>
                  <td className="p-3 text-right font-mono">${fmtPrice(p.entryPrice)}</td>
                  <td className={`p-3 text-right font-mono font-bold ${pnlColor}`}>${fmtPrice(p.currentPrice)}</td>
                  <td className="p-3 text-right font-mono text-outline">{p.qty?.toFixed(4)}</td>
                  <td className="p-3 text-right font-mono text-outline">{p.leverage ? `${p.leverage}x` : '--'}</td>
                  <td className={`p-3 text-right font-bold ${pnlColor}`}>
                    {p.unrealizedPnlPct >= 0 ? '+' : ''}{p.unrealizedPnlPct?.toFixed(2)}%
                  </td>
                  <td className={`p-3 text-right font-bold ${pnlColor}`}>
                    {p.unrealizedPnlUsd >= 0 ? '+' : ''}${Math.abs(p.unrealizedPnlUsd)?.toFixed(2)}
                  </td>
                  <td className="p-3 text-right text-outline font-mono">{p.targetPrice ? `$${fmtPrice(p.targetPrice)}` : '--'}</td>
                  <td className="p-3 text-right text-error/70 font-mono">{p.safetyStop ? `$${fmtPrice(p.safetyStop)}` : '--'}</td>
                  <td className="p-3 text-right font-mono text-outline">{p.liquidationPrice ? `$${p.liquidationPrice.toFixed(2)}` : '--'}</td>
                  <td className="p-3 text-right text-outline">{p.holdTimeMin?.toFixed(0)}분{p.timeRemainingMin != null ? ` / ${p.timeRemainingMin.toFixed(0)}분` : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 1초봉 실시간 차트 패널 */}
      {selected && (
        <div className="bg-surface-container-lowest rounded shadow-sm overflow-hidden">
          <div className="p-4 border-b border-surface-container-high/30 flex items-center justify-between">
            <h3 className="font-headline font-bold text-sm flex items-center gap-2">
              <span className="material-symbols-outlined text-lg text-primary">candlestick_chart</span>
              {selected.symbol}
              <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                selected.direction === 'LONG' ? 'bg-success/10 text-success' : 'bg-error/10 text-error'
              }`}>{selected.direction}</span>
              <span className="text-xs text-outline font-label">1초봉 · 최근 5분</span>
            </h3>
            <button onClick={() => setSelected(null)}
              className="material-symbols-outlined text-lg text-outline hover:text-on-surface transition-colors">
              close
            </button>
          </div>
          <div className="h-[400px]">
            <Candle1sChart
              symbol={selected.symbol}
              entryPrice={selected.entryPrice}
              entryTime={selected.entryTime}
              targetPrice={selected.targetPrice}
              safetyStop={selected.safetyStop}
              direction={selected.direction}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="bg-surface-container-lowest p-5 rounded shadow-sm">
      <span className="text-[10px] font-label text-outline uppercase tracking-wider block mb-1">{label}</span>
      <span className={`text-xl font-bold font-label ${color}`}>{value}</span>
    </div>
  );
}
