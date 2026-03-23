'use client';

import { useEffect, useState, useCallback } from 'react';
import { Candle1sChart } from '@/components/candle-1s-chart';
import { TradeReplayChart } from '@/components/trade-replay-chart';

/** 가격 표시: 가격대에 맞는 소수점 자릿수 자동 결정 */
const fmtPrice = (price?: number) => {
  if (price == null || isNaN(price)) return '--';
  if (price >= 1000) return price.toFixed(2);
  if (price >= 1)    return price.toFixed(4);
  if (price >= 0.01) return price.toFixed(5);
  return price.toFixed(6);
};

export default function TerminalPage() {
  const [regime, setRegime] = useState('NEUTRAL');
  const [stats, setStats] = useState({ plans: 0, signals: 0, entries: 0, exits: 0, balance: 10000, walletBalance: 10000, mode: 'SIM' });

  // 실시간 포지션 + 포트폴리오
  const [livePositions, setLivePositions] = useState<any[]>([]);
  const [totalPnl, setTotalPnl] = useState(0);
  const [recentClosed, setRecentClosed] = useState<any[]>([]);
  const [planStatuses, setPlanStatuses] = useState<any[]>([]);
  const [replayTradeId, setReplayTradeId] = useState<number | null>(null);

  // LLM 활동 로그
  const [llmLogs, setLlmLogs] = useState<any[]>([]);

  // 포지션 클릭 → 1초봉 차트
  const [posChart, setPosChart] = useState<{ symbol: string; entryPrice: number; entryTime?: number; targetPrice?: number; safetyStop?: number; direction: string } | null>(null);

  const fetchDashboard = useCallback(async () => {
    try {
      const res = await fetch('/api/coin/dashboard');
      if (!res.ok) return;
      const data = await res.json();
      if (data.execution) {
        setStats({
          plans: data.stats?.activePlans || 0,
          signals: data.stats?.signalCount || 0,
          entries: data.execution.entries || 0,
          exits: data.execution.exits || 0,
          balance: data.execution.balance || 10000,
          walletBalance: data.execution.walletBalance || data.execution.balance || 10000,
          mode: data.execution.mode || 'SIM',
        });
      }
      if (data.macroRegime) setRegime(data.macroRegime);
    } catch {}
  }, []);

  const fetchLivePositions = useCallback(async () => {
    try {
      const res = await fetch('/api/coin/positions/live');
      if (!res.ok) return;
      const data = await res.json();
      setLivePositions(data.positions || []);
      setTotalPnl(data.totalUnrealizedPnl || 0);
    } catch {}
  }, []);

  const fetchPortfolio = useCallback(async () => {
    try {
      const res = await fetch('/api/coin/positions?status=CLOSED');
      if (!res.ok) return;
      const data = await res.json();
      setRecentClosed((data || []).slice(0, 10));
    } catch {}
  }, []);

  const fetchPlanStatuses = useCallback(async () => {
    try {
      const res = await fetch('/api/coin/plans/status');
      if (!res.ok) return;
      const data = await res.json();
      setPlanStatuses(data.plans || []);
    } catch {}
  }, []);

  const fetchLLMLogs = useCallback(async () => {
    try {
      const res = await fetch('/api/coin/realtime/z2-recent?limit=10');
      if (!res.ok) return;
      const data = await res.json();
      setLlmLogs(data || []);
    } catch {}
  }, []);

  useEffect(() => {
    fetchDashboard();
    fetchLivePositions();
    fetchPortfolio();
    fetchPlanStatuses();
    fetchLLMLogs();
    const t1 = setInterval(fetchDashboard, 1000);
    const t2 = setInterval(fetchLivePositions, 1000);
    const t3 = setInterval(fetchPortfolio, 3000);
    const t4 = setInterval(fetchPlanStatuses, 2000);
    const t5 = setInterval(fetchLLMLogs, 3000);
    return () => { clearInterval(t1); clearInterval(t2); clearInterval(t3); clearInterval(t4); clearInterval(t5); };
  }, [fetchDashboard, fetchLivePositions, fetchPortfolio, fetchPlanStatuses, fetchLLMLogs]);

  // 오늘 통계
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayClosed = recentClosed.filter(p => p.exit_time?.startsWith(todayStr));
  const realizedPnl = todayClosed.reduce((s, p) => s + (p.pnl_amount || 0), 0);
  const winCount = todayClosed.filter(p => (p.pnl_amount || 0) > 0).length;
  const winRate = todayClosed.length > 0 ? (winCount / todayClosed.length * 100) : 0;

  return (
    <div className="p-6 grid grid-cols-12 gap-4">

      {/* ── 좌측: 포트폴리오 (넓게) ── */}
      <div className="col-span-12 lg:col-span-8 space-y-4">

        {/* 시스템 상태 요약 바 */}
        <div className="bg-primary text-on-primary p-4 rounded shadow-md relative overflow-hidden">
          <div className="absolute -right-4 -top-4 w-24 h-24 bg-white/5 rounded-full blur-2xl" />
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-6">
              <div>
                <span className="text-[9px] uppercase opacity-60 block font-label">모드</span>
                <span className="text-sm font-bold font-label">{stats.mode}</span>
              </div>
              <div>
                <span className="text-[9px] uppercase opacity-60 block font-label">레짐</span>
                <span className="text-sm font-bold font-label">{regime.replace('_', '-')}</span>
              </div>
              <div>
                <span className="text-[9px] uppercase opacity-60 block font-label">잔고</span>
                <span className="text-sm font-bold font-label">${stats.balance.toLocaleString(undefined, { minimumFractionDigits: 0 })}</span>
              </div>
              <div>
                <span className="text-[9px] uppercase opacity-60 block font-label">평가금</span>
                <span className="text-sm font-bold font-label">${(stats.walletBalance ?? stats.balance).toLocaleString(undefined, { minimumFractionDigits: 0 })}</span>
              </div>
            </div>
            <div className="flex items-center gap-6">
              <div className="text-right">
                <span className="text-[9px] uppercase opacity-60 block font-label">진입/청산</span>
                <span className="text-sm font-bold font-label">{stats.entries}/{stats.exits}</span>
              </div>
              <div className="text-right">
                <span className="text-[9px] uppercase opacity-60 block font-label">활성플랜</span>
                <span className="text-sm font-bold font-label">{stats.plans}개</span>
              </div>
            </div>
          </div>
        </div>

        {/* 요약 통계 카드 */}
        <div className="grid grid-cols-4 gap-3">
          <MiniCard label="미실현 P&L" value={`${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`} color={totalPnl >= 0 ? 'text-success' : 'text-error'} />
          <MiniCard label="오늘 실현 P&L" value={`${realizedPnl >= 0 ? '+' : ''}$${realizedPnl.toFixed(2)}`} color={realizedPnl >= 0 ? 'text-success' : 'text-error'} />
          <MiniCard label="오늘 거래" value={`${todayClosed.length}회`} />
          <MiniCard label="승률" value={todayClosed.length > 0 ? `${winRate.toFixed(0)}%` : '--'} />
        </div>

        {/* 오픈 포지션 테이블 */}
        <div className="bg-surface-container-lowest rounded shadow-sm overflow-hidden">
          <div className="p-3 border-b border-surface-container-high/30 flex items-center justify-between">
            <h3 className="font-headline font-bold text-xs uppercase tracking-widest flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-success animate-pulse" />
              오픈 포지션 ({livePositions.length})
            </h3>
            <span className={`text-xs font-bold font-label ${totalPnl >= 0 ? 'text-success' : 'text-error'}`}>
              미실현: {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}
            </span>
          </div>
          {livePositions.length === 0 ? (
            <div className="p-8 text-center text-outline">
              <span className="material-symbols-outlined text-3xl opacity-20 block mb-2">inbox</span>
              <span className="text-xs">오픈 포지션 없음. LLM 시그널 대기 중...</span>
            </div>
          ) : (
            <table className="w-full text-left font-label">
              <thead>
                <tr className="text-[10px] text-outline uppercase border-b border-surface-container-high/30">
                  <th className="p-3 font-semibold">심볼</th>
                  <th className="p-3 font-semibold">방향</th>
                  <th className="p-3 font-semibold text-right">진입가</th>
                  <th className="p-3 font-semibold text-right">현재가</th>
                  <th className="p-3 font-semibold text-right">수익률</th>
                  <th className="p-3 font-semibold text-right">손익</th>
                  <th className="p-3 font-semibold text-right">목표가</th>
                  <th className="p-3 font-semibold text-right">손절가</th>
                  <th className="p-3 font-semibold text-right">보유</th>
                </tr>
              </thead>
              <tbody className="text-sm">
                {livePositions.map((p: any) => {
                  const pnlColor = p.unrealizedPnlUsd >= 0 ? 'text-success' : 'text-error';
                  const isSelected = posChart?.symbol === p.symbol;
                  return (
                    <tr key={p.id}
                        onClick={() => {
                          if (isSelected) { setPosChart(null); }
                          else { setPosChart({
                            symbol: p.symbol, entryPrice: p.entryPrice, direction: p.direction,
                            entryTime: p.entryTime ? Math.floor(new Date(p.entryTime).getTime() / 1000) : undefined,
                            targetPrice: p.targetPrice || undefined,
                            safetyStop: p.safetyStop || undefined,
                          }); }
                        }}
                        className={`border-b border-surface-container-high/10 hover:bg-surface transition-colors cursor-pointer ${isSelected ? 'bg-primary/5' : ''}`}>
                      <td className="p-3 font-bold text-primary">
                        <span className="flex items-center gap-1">
                          {p.symbol.replace('USDT', '')}
                          <span className={`material-symbols-outlined text-sm transition-transform ${isSelected ? 'rotate-180' : ''}`}>expand_more</span>
                        </span>
                      </td>
                      <td className="p-3">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${p.direction === 'LONG' ? 'bg-success/10 text-success' : 'bg-error/10 text-error'}`}>{p.direction}</span>
                      </td>
                      <td className="p-3 text-right font-mono">${fmtPrice(p.entryPrice)}</td>
                      <td className={`p-3 text-right font-mono font-bold ${pnlColor}`}>${fmtPrice(p.currentPrice)}</td>
                      <td className={`p-3 text-right font-bold ${pnlColor}`}>{p.unrealizedPnlPct >= 0 ? '+' : ''}{p.unrealizedPnlPct?.toFixed(2)}%</td>
                      <td className={`p-3 text-right font-bold ${pnlColor}`}>{p.unrealizedPnlUsd >= 0 ? '+' : ''}${Math.abs(p.unrealizedPnlUsd)?.toFixed(2)}</td>
                      <td className="p-3 text-right text-outline font-mono text-xs">{p.targetPrice ? `$${fmtPrice(p.targetPrice)}` : '--'}</td>
                      <td className="p-3 text-right text-error/70 font-mono text-xs">{p.safetyStop ? `$${fmtPrice(p.safetyStop)}` : '--'}</td>
                      <td className="p-3 text-right text-outline text-xs">{p.holdTimeMin?.toFixed(0)}분</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* 1초봉 차트 (포지션 클릭 시) */}
        {posChart && (
          <div className="bg-surface-container-lowest rounded shadow-sm overflow-hidden">
            <div className="p-3 border-b border-surface-container-high/30 flex items-center justify-between">
              <h3 className="font-headline font-bold text-sm flex items-center gap-2">
                <span className="material-symbols-outlined text-lg text-primary">candlestick_chart</span>
                {posChart.symbol}
                <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${posChart.direction === 'LONG' ? 'bg-success/10 text-success' : 'bg-error/10 text-error'}`}>{posChart.direction}</span>
                <span className="text-xs text-outline font-label">1초봉 실시간</span>
              </h3>
              <button onClick={() => setPosChart(null)} className="material-symbols-outlined text-lg text-outline hover:text-on-surface">close</button>
            </div>
            <div className="h-[350px]">
              <Candle1sChart
                symbol={posChart.symbol}
                entryPrice={posChart.entryPrice}
                entryTime={posChart.entryTime}
                targetPrice={posChart.targetPrice}
                safetyStop={posChart.safetyStop}
                direction={posChart.direction}
              />
            </div>
          </div>
        )}

        {/* 최근 청산 */}
        <div className="bg-surface-container-lowest rounded shadow-sm overflow-hidden">
          <div className="p-3 border-b border-surface-container-high/30">
            <h3 className="font-headline font-bold text-xs uppercase tracking-widest">최근 청산</h3>
          </div>
          {recentClosed.length === 0 ? (
            <div className="p-6 text-center text-outline text-xs">거래 내역 없음</div>
          ) : (
            <table className="w-full text-left font-label">
              <thead>
                <tr className="text-[10px] text-outline uppercase border-b border-surface-container-high/30">
                  <th className="p-2.5 font-semibold">시각</th>
                  <th className="p-2.5 font-semibold">심볼</th>
                  <th className="p-2.5 font-semibold">방향</th>
                  <th className="p-2.5 font-semibold text-right">진입</th>
                  <th className="p-2.5 font-semibold text-right">청산</th>
                  <th className="p-2.5 font-semibold text-right">손익</th>
                  <th className="p-2.5 font-semibold">사유</th>
                </tr>
              </thead>
              <tbody className="text-[11px]">
                {recentClosed.map((p: any) => {
                  const pnl = p.pnl_amount ?? 0;
                  const isProfit = pnl >= 0;
                  return (
                    <tr key={p.id} className="border-b border-surface-container-high/10 hover:bg-surface cursor-pointer" onClick={() => setReplayTradeId(replayTradeId === p.id ? null : p.id)}>
                      <td className="p-2.5 text-outline">{p.exit_time ? new Date(p.exit_time).toLocaleString('ko-KR', { timeZone: 'America/New_York', hour12: false, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '--'}</td>
                      <td className="p-2.5 font-bold">{String(p.symbol).replace('USDT', '')}</td>
                      <td className="p-2.5"><span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${p.direction === 'LONG' ? 'bg-success/10 text-success' : 'bg-error/10 text-error'}`}>{p.direction}</span></td>
                      <td className="p-2.5 text-right font-mono">${fmtPrice(p.entry_price)}</td>
                      <td className="p-2.5 text-right font-mono">{p.exit_price ? `$${fmtPrice(p.exit_price)}` : '--'}</td>
                      <td className={`p-2.5 text-right font-bold ${isProfit ? 'text-success' : 'text-error'}`}>{pnl >= 0 ? '+' : ''}${Math.abs(pnl).toFixed(2)}</td>
                      <td className="p-2.5"><span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${p.exit_reason === 'TARGET' || p.exit_reason === 'ATR_TARGET' ? 'bg-success/10 text-success' : p.exit_reason === 'SAFETY_STOP' ? 'bg-error/10 text-error' : 'bg-surface-variant text-outline'}`}>{p.exit_reason || '--'}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* 리플레이 차트 (청산 거래 클릭 시) */}
        {replayTradeId && (
          <TradeReplayChart
            positionId={replayTradeId}
            onClose={() => setReplayTradeId(null)}
          />
        )}
      </div>

      {/* ── 우측: LLM 활동 로그 ── */}
      <div className="col-span-12 lg:col-span-4 space-y-4">
        <div className="bg-surface-container-lowest rounded shadow-sm overflow-hidden">
          <div className="p-3 border-b border-surface-container-high/30 flex items-center justify-between">
            <h3 className="font-headline font-bold text-xs uppercase tracking-widest flex items-center gap-2">
              <span className="material-symbols-outlined text-sm text-primary">smart_toy</span>
              LLM 활동
            </h3>
            <span className="text-[10px] font-label text-outline">{llmLogs.length}건</span>
          </div>
          <div className="max-h-[calc(100vh-200px)] overflow-y-auto">
            {llmLogs.length === 0 ? (
              <div className="p-8 text-center text-outline">
                <span className="material-symbols-outlined text-2xl opacity-20 block mb-2">psychology</span>
                <span className="text-xs">LLM 분석 대기 중...</span>
              </div>
            ) : llmLogs.map((log: any) => (
              <LLMLogEntry key={log.id} log={log} />
            ))}
          </div>
        </div>
      </div>

      {/* ── 하단: 활성 플랜 매트릭스 ── */}
      {planStatuses.filter(p => p.timeRemainingMin > 0).length > 0 && (
        <div className="col-span-12 bg-surface-container-lowest rounded shadow-sm overflow-hidden">
          <div className="p-3 border-b border-surface-container-high/30 flex items-center justify-between">
            <h3 className="font-headline font-bold text-xs uppercase tracking-widest">활성 플랜 조건 매트릭스</h3>
            <span className="text-[10px] font-label text-outline">{planStatuses.filter(p => p.timeRemainingMin > 0).length}개 플랜</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left font-label">
              <thead>
                <tr className="text-[10px] text-outline uppercase border-b border-surface-container-high/30">
                  <th className="p-3 font-semibold">ID</th>
                  <th className="p-3 font-semibold">심볼</th>
                  <th className="p-3 font-semibold">방향</th>
                  <th className="p-3 font-semibold">현재가</th>
                  <th className="p-3 font-semibold">진입가</th>
                  <th className="p-3 font-semibold">목표가</th>
                  <th className="p-3 font-semibold">조건 충족</th>
                  <th className="p-3 font-semibold">조건 상세</th>
                  <th className="p-3 font-semibold">남은시간</th>
                  <th className="p-3 font-semibold">확신도</th>
                  <th className="p-3 font-semibold">근거</th>
                </tr>
              </thead>
              <tbody className="text-[11px]">
                {planStatuses.filter(p => p.timeRemainingMin > 0).map(plan => (
                  <tr key={plan.id} className="border-b border-surface-container-high/10 hover:bg-surface transition-colors">
                    <td className="p-3 text-outline">#{plan.id}</td>
                    <td className="p-3 font-bold">{plan.symbol?.replace('USDT','')}</td>
                    <td className="p-3">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${plan.direction === 'LONG' ? 'bg-success/10 text-success' : 'bg-error/10 text-error'}`}>{plan.direction}</span>
                    </td>
                    <td className="p-3 font-mono text-[10px]">{plan.currentPrice ? `$${Number(plan.currentPrice).toLocaleString()}` : '--'}</td>
                    <td className="p-3 font-mono text-[10px]">{plan.entryPrice ? `$${Number(plan.entryPrice).toLocaleString()}` : '--'}</td>
                    <td className="p-3 font-mono text-[10px]">{plan.targetPrice ? `$${Number(plan.targetPrice).toLocaleString()}` : '--'}</td>
                    <td className="p-3">
                      <div className="flex items-center gap-2">
                        <div className="w-16 bg-surface-container-low h-1.5 rounded-full">
                          <div className="bg-success h-full rounded-full transition-all" style={{ width: `${plan.conditionsTotal > 0 ? (plan.conditionsMet / plan.conditionsTotal) * 100 : 0}%` }} />
                        </div>
                        <span className="font-bold text-[10px]">{plan.conditionsMet}/{plan.conditionsTotal}</span>
                      </div>
                    </td>
                    <td className="p-3">
                      <div className="flex gap-1.5 flex-wrap">
                        {plan.conditions.map((c: any, i: number) => (
                          <span key={i} className={`px-1.5 py-0.5 rounded text-[9px] font-medium ${c.met ? 'bg-success/10 text-success' : 'bg-surface-container-high text-outline'}`}>{c.field}</span>
                        ))}
                      </div>
                    </td>
                    <td className="p-3 text-outline">{plan.timeRemainingMin > 0 ? `${plan.timeRemainingMin.toFixed(0)}분` : '만료'}</td>
                    <td className="p-3 font-bold">{((plan.confidence || 0) * 100).toFixed(0)}%</td>
                    <td className="p-3 text-[10px] text-outline max-w-[200px] truncate" title={plan.reasoning || ''}>{plan.reasoning || '--'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── 서브 컴포넌트 ── */

function MiniCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-surface-container-lowest p-4 rounded shadow-sm">
      <span className="text-[9px] font-label text-outline uppercase block mb-1">{label}</span>
      <span className={`text-lg font-bold font-label ${color || 'text-on-surface'}`}>{value}</span>
    </div>
  );
}

const TYPE_LABELS: Record<string, { label: string; icon: string; color: string }> = {
  sentiment:         { label: '감성분석', icon: 'mood', color: 'text-blue-500' },
  briefing:          { label: '브리핑', icon: 'summarize', color: 'text-purple-500' },
  scenario:          { label: '시나리오', icon: 'psychology', color: 'text-orange-500' },
  validate_position: { label: '포지션검증', icon: 'verified', color: 'text-teal-500' },
};

const LLM_SOURCE_LABELS: Record<string, { label: string; bg: string; text: string }> = {
  cloud:  { label: 'Claude CLI',  bg: 'bg-orange-100', text: 'text-orange-700' },
  local:  { label: 'LOCAL LLM',   bg: 'bg-blue-100',   text: 'text-blue-700' },
  system: { label: 'LOCAL LLM',   bg: 'bg-blue-100',   text: 'text-blue-700' },
};

function LLMLogEntry({ log }: { log: any }) {
  const [expanded, setExpanded] = useState(false);
  const typeInfo = TYPE_LABELS[log.analysis_type] || { label: log.analysis_type, icon: 'smart_toy', color: 'text-outline' };
  const ts = log.ts ? new Date(log.ts) : null;
  const timeStr = ts ? ts.toLocaleString('ko-KR', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '--';
  const confPct = ((log.confidence || 0) * 100).toFixed(0);

  // 결과에서 주요 정보 추출
  let summary = '';
  const result = log.result;
  if (typeof result === 'object' && result) {
    if (log.analysis_type === 'sentiment') {
      summary = `${result.sentiment > 0 ? '긍정' : result.sentiment < 0 ? '부정' : '중립'} (${result.sentiment?.toFixed(2)}) — ${result.key_topic || ''}`;
    } else if (log.analysis_type === 'briefing') {
      summary = result.summary || `${result.direction_bias || ''} (${result.regime_diagnosis || ''})`;
    } else if (log.analysis_type === 'scenario') {
      const count = result.scenarios?.length || 0;
      const rec = result.recommended_scenario || '';
      summary = `${count}개 시나리오 생성${rec ? ` — 추천: ${rec}` : ''}`;
    }
  }

  return (
    <div className={`border-b border-surface-container-high/10 hover:bg-surface/50 transition-colors cursor-pointer ${expanded ? 'bg-surface/30' : ''}`}
         onClick={() => setExpanded(!expanded)}>
      <div className="p-3 flex items-start gap-2">
        <span className={`material-symbols-outlined text-base mt-0.5 ${typeInfo.color}`}>{typeInfo.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className={`text-[10px] font-bold ${typeInfo.color}`}>{typeInfo.label}</span>
            {log.symbol && <span className="text-[10px] font-bold text-on-surface">{log.symbol.replace('USDT', '')}</span>}
            {(() => {
              const src = LLM_SOURCE_LABELS[log.llm_source] || { label: log.llm_source || '?', bg: 'bg-gray-100', text: 'text-gray-500' };
              return <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${src.bg} ${src.text}`}>{src.label}</span>;
            })()}
            <span className="text-[9px] text-outline ml-auto">{timeStr} ET</span>
          </div>
          <p className="text-[11px] text-on-surface-variant truncate">{summary || '--'}</p>
          <div className="flex items-center gap-3 mt-1">
            <span className="text-[9px] text-outline">신뢰도 {confPct}%</span>
            {log.latency_ms && <span className="text-[9px] text-outline">{(log.latency_ms / 1000).toFixed(1)}s</span>}
          </div>
        </div>
      </div>
      {expanded && result && (
        <div className="px-3 pb-3">
          <pre className="text-[10px] text-on-surface-variant bg-surface-container-low rounded p-2 overflow-x-auto max-h-48 whitespace-pre-wrap break-words">
            {typeof result === 'string' ? result : JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
