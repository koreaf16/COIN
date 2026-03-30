'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { Candle1sChart } from '@/components/candle-1s-chart';
import { StructureBadges } from '@/components/structure-badges';
import { TradeReplayChart } from '@/components/trade-replay-chart';

const fmtPrice = (price?: number) => {
  if (price == null || isNaN(price)) return '--';
  if (price >= 1000) return price.toFixed(2);
  if (price >= 1)    return price.toFixed(4);
  if (price >= 0.01) return price.toFixed(5);
  return price.toFixed(6);
};

const TASK_LABELS: Record<string, string> = {
  sentiment:          'SENTIMENT',
  briefing:           'BRIEFING',
  scenario:           'SCENARIO',
  unified_plan:       'UNIFIED PLAN',
  unified_plan_cloud: 'UNIFIED PLAN',
  validate_position:  'VALIDATE',
  interpret_event:    'EVENT',
};

const PROVIDER_BADGE: Record<string, { label: string; cls: string }> = {
  deepseek: { label: 'DeepSeek', cls: 'bg-blue-500/15 text-blue-400' },
  ollama:   { label: 'Qwen/Ollama', cls: 'bg-cyan-500/15 text-cyan-300' },
  claude:   { label: 'Claude',   cls: 'bg-orange-500/15 text-orange-400' },
  gemini:   { label: 'Gemini',   cls: 'bg-green-500/15 text-green-400' },
};

const ET_TIME_ZONE = 'America/New_York';

const etDateString = (value: string | Date) =>
  new Date(value).toLocaleDateString('en-CA', { timeZone: ET_TIME_ZONE });

export default function TerminalPage() {
  const [regime, setRegime] = useState('NEUTRAL');
  const [stats, setStats] = useState({ plans: 0, signals: 0, entries: 0, exits: 0, balance: 10000, walletBalance: 10000, mode: 'SIM' });

  const [livePositions, setLivePositions] = useState<any[]>([]);
  const [totalPnl, setTotalPnl] = useState(0);
  const [closedPositions, setClosedPositions] = useState<any[]>([]);
  const [recentClosed, setRecentClosed] = useState<any[]>([]);
  const [planStatuses, setPlanStatuses] = useState<any[]>([]);
  const [replayTradeId, setReplayTradeId] = useState<number | null>(null);
  const [llmActive, setLlmActive] = useState<any[]>([]);
  const [llmConnected, setLlmConnected] = useState(false);

  const [posChart, setPosChart] = useState<{
    symbol: string; entryPrice: number; entryTime?: number;
    targetPrice?: number; safetyStop?: number; direction: string;
  } | null>(null);

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
      setClosedPositions(data || []);
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

  const fetchLlmActive = useCallback(async () => {
    try {
      const res = await fetch('/api/coin/llm-active');
      if (!res.ok) { setLlmConnected(false); return; }
      const data = await res.json();
      setLlmConnected(true);
      setLlmActive(data.calls || []);
    } catch { setLlmConnected(false); }
  }, []);

  useEffect(() => {
    fetchDashboard(); fetchLivePositions(); fetchPortfolio(); fetchPlanStatuses(); fetchLlmActive();
    const t1 = setInterval(fetchDashboard, 1000);
    const t2 = setInterval(fetchLivePositions, 1000);
    const t3 = setInterval(fetchPortfolio, 3000);
    const t4 = setInterval(fetchPlanStatuses, 2000);
    const t5 = setInterval(fetchLlmActive, 500);
    return () => { clearInterval(t1); clearInterval(t2); clearInterval(t3); clearInterval(t4); clearInterval(t5); };
  }, [fetchDashboard, fetchLivePositions, fetchPortfolio, fetchPlanStatuses, fetchLlmActive]);

  const todayStr = etDateString(new Date());
  const todayClosed = closedPositions.filter(p => p.exit_time && etDateString(p.exit_time) === todayStr);
  const realizedPnl = todayClosed.reduce((s, p) => s + (p.pnl_amount || 0), 0);
  const winCount = todayClosed.filter(p => (p.pnl_amount || 0) > 0).length;
  const winRate = todayClosed.length > 0 ? (winCount / todayClosed.length * 100) : 0;

  return (
    <div className="p-6 grid grid-cols-12 gap-4">

      {/* ── 좌측: 포트폴리오 ── */}
      <div className="col-span-12 lg:col-span-8 space-y-4">

        {/* 시스템 상태 바 */}
        <div className="bg-primary text-on-primary p-4 rounded shadow-md relative overflow-hidden">
          <div className="absolute -right-4 -top-4 w-24 h-24 bg-white/5 rounded-full blur-2xl" />
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-6">
              <div><span className="text-[9px] uppercase opacity-60 block font-label">모드</span><span className="text-sm font-bold font-label">{stats.mode}</span></div>
              <div><span className="text-[9px] uppercase opacity-60 block font-label">레짐</span><span className="text-sm font-bold font-label">{regime.replace('_', '-')}</span></div>
              <div><span className="text-[9px] uppercase opacity-60 block font-label">잔고</span><span className="text-sm font-bold font-label">${stats.balance.toLocaleString(undefined, { minimumFractionDigits: 0 })}</span></div>
              <div><span className="text-[9px] uppercase opacity-60 block font-label">평가금</span><span className="text-sm font-bold font-label">${(stats.walletBalance ?? stats.balance).toLocaleString(undefined, { minimumFractionDigits: 0 })}</span></div>
            </div>
            <div className="flex items-center gap-6">
              <div className="text-right"><span className="text-[9px] uppercase opacity-60 block font-label">진입/청산</span><span className="text-sm font-bold font-label">{stats.entries}/{stats.exits}</span></div>
              <div className="text-right"><span className="text-[9px] uppercase opacity-60 block font-label">활성플랜</span><span className="text-sm font-bold font-label">{stats.plans}개</span></div>
            </div>
          </div>
        </div>

        {/* 요약 카드 */}
        <div className="grid grid-cols-4 gap-3">
          <MiniCard label="미실현 P&L" value={`${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`} color={totalPnl >= 0 ? 'text-success' : 'text-error'} />
          <MiniCard label="오늘 실현 P&L" value={`${realizedPnl >= 0 ? '+' : ''}$${realizedPnl.toFixed(2)}`} color={realizedPnl >= 0 ? 'text-success' : 'text-error'} />
          <MiniCard label="오늘 거래" value={`${todayClosed.length}회`} />
          <MiniCard label="승률" value={todayClosed.length > 0 ? `${winRate.toFixed(0)}%` : '--'} />
        </div>

        {/* 오픈 포지션 */}
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
                  <th className="p-3 font-semibold">심볼</th><th className="p-3 font-semibold">방향</th>
                  <th className="p-3 font-semibold text-right">진입가</th><th className="p-3 font-semibold text-right">현재가</th>
                  <th className="p-3 font-semibold text-right">수익률</th><th className="p-3 font-semibold text-right">손익</th>
                  <th className="p-3 font-semibold text-right">투입금</th>
                  <th className="p-3 font-semibold text-right">목표가</th><th className="p-3 font-semibold text-right">손절가</th>
                  <th className="p-3 font-semibold text-right">보유</th>
                </tr>
              </thead>
              <tbody className="text-sm">
                {livePositions.map((p: any) => {
                  const pnlColor = p.unrealizedPnlUsd >= 0 ? 'text-success' : 'text-error';
                  const isSelected = posChart?.symbol === p.symbol;
                  return (
                    <tr key={p.id}
                        onClick={() => isSelected ? setPosChart(null) : setPosChart({
                          symbol: p.symbol, entryPrice: p.entryPrice, direction: p.direction,
                          entryTime: p.entryTime ? Math.floor(new Date(p.entryTime).getTime() / 1000) : undefined,
                          targetPrice: p.targetPrice || undefined, safetyStop: p.safetyStop || undefined,
                        })}
                        className={`border-b border-surface-container-high/10 hover:bg-surface transition-colors cursor-pointer ${isSelected ? 'bg-primary/5' : ''}`}>
                      <td className="p-3 font-bold text-primary">
                        <div className="space-y-1">
                          <span className="flex items-center gap-1">
                            {p.symbol.replace('USDT', '')}
                            <span className={`material-symbols-outlined text-sm transition-transform ${isSelected ? 'rotate-180' : ''}`}>expand_more</span>
                          </span>
                          <StructureBadges structure={p.structure} compact />
                        </div>
                      </td>
                      <td className="p-3"><span className={`px-2 py-0.5 rounded text-[10px] font-bold ${p.direction === 'LONG' ? 'bg-success/10 text-success' : 'bg-error/10 text-error'}`}>{p.direction}</span></td>
                      <td className="p-3 text-right font-mono">${fmtPrice(p.entryPrice)}</td>
                      <td className={`p-3 text-right font-mono font-bold ${pnlColor}`}>${fmtPrice(p.currentPrice)}</td>
                      <td className={`p-3 text-right font-bold ${pnlColor}`}>{p.unrealizedPnlPct >= 0 ? '+' : ''}{p.unrealizedPnlPct?.toFixed(2)}%</td>
                      <td className={`p-3 text-right font-bold ${pnlColor}`}>{p.unrealizedPnlUsd >= 0 ? '+' : '-'}${Math.abs(p.unrealizedPnlUsd)?.toFixed(2)}</td>
                      <td className="p-3 text-right font-mono text-xs text-outline">
                        {p.marginUsed != null
                          ? `$${p.marginUsed.toFixed(0)} ×${p.leverage}`
                          : p.notional != null
                            ? `$${p.notional.toFixed(0)}`
                            : '--'}
                      </td>
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

        {/* 1초봉 차트 */}
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
              <Candle1sChart symbol={posChart.symbol} entryPrice={posChart.entryPrice}
                entryTime={posChart.entryTime} targetPrice={posChart.targetPrice}
                safetyStop={posChart.safetyStop} direction={posChart.direction} />
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
                  <th className="p-2.5 font-semibold">시각</th><th className="p-2.5 font-semibold">심볼</th>
                  <th className="p-2.5 font-semibold">방향</th><th className="p-2.5 font-semibold text-right">진입</th>
                  <th className="p-2.5 font-semibold text-right">청산</th><th className="p-2.5 font-semibold text-right">손익</th>
                  <th className="p-2.5 font-semibold">사유</th>
                </tr>
              </thead>
              <tbody className="text-[11px]">
                {recentClosed.map((p: any) => {
                  const pnl = p.pnl_amount ?? 0;
                  return (
                    <tr key={p.id} className="border-b border-surface-container-high/10 hover:bg-surface cursor-pointer"
                        onClick={() => setReplayTradeId(replayTradeId === p.id ? null : p.id)}>
                      <td className="p-2.5 text-outline">{p.exit_time ? new Date(p.exit_time).toLocaleString('ko-KR', { timeZone: 'America/New_York', hour12: false, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '--'}</td>
                      <td className="p-2.5 font-bold">{String(p.symbol).replace('USDT', '')}</td>
                      <td className="p-2.5"><span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${p.direction === 'LONG' ? 'bg-success/10 text-success' : 'bg-error/10 text-error'}`}>{p.direction}</span></td>
                      <td className="p-2.5 text-right font-mono">${fmtPrice(p.entry_price)}</td>
                      <td className="p-2.5 text-right font-mono">{p.exit_price ? `$${fmtPrice(p.exit_price)}` : '--'}</td>
                      <td className={`p-2.5 text-right font-bold ${pnl >= 0 ? 'text-success' : 'text-error'}`}>{pnl >= 0 ? '+' : '-'}${Math.abs(pnl).toFixed(2)}</td>
                      <td className="p-2.5"><span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${p.exit_reason === 'TARGET' || p.exit_reason === 'ATR_TARGET' ? 'bg-success/10 text-success' : p.exit_reason === 'SAFETY_STOP' ? 'bg-error/10 text-error' : 'bg-surface-variant text-outline'}`}>{p.exit_reason || '--'}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {replayTradeId && <TradeReplayChart positionId={replayTradeId} onClose={() => setReplayTradeId(null)} />}

        {/* 활성 플랜 */}
        {planStatuses.filter(p => p.timeRemainingMin > 0).length > 0 && (
          <div className="bg-surface-container-lowest rounded shadow-sm overflow-hidden">
            <div className="p-3 border-b border-surface-container-high/30 flex items-center justify-between">
              <h3 className="font-headline font-bold text-xs uppercase tracking-widest">활성 플랜 조건 매트릭스</h3>
              <span className="text-[10px] font-label text-outline">{planStatuses.filter(p => p.timeRemainingMin > 0).length}개</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left font-label">
                <thead>
                  <tr className="text-[10px] text-outline uppercase border-b border-surface-container-high/30">
                    <th className="p-3 font-semibold">ID</th><th className="p-3 font-semibold">심볼</th>
                    <th className="p-3 font-semibold">방향</th><th className="p-3 font-semibold">현재가</th>
                    <th className="p-3 font-semibold">진입가</th><th className="p-3 font-semibold">목표가</th>
                    <th className="p-3 font-semibold">조건</th><th className="p-3 font-semibold">조건 상세</th>
                    <th className="p-3 font-semibold">남은시간</th><th className="p-3 font-semibold">확신도</th>
                    <th className="p-3 font-semibold">근거</th>
                  </tr>
                </thead>
                <tbody className="text-[11px]">
                  {planStatuses.filter(p => p.timeRemainingMin > 0).map(plan => (
                    <tr key={plan.id} className="border-b border-surface-container-high/10 hover:bg-surface">
                      <td className="p-3 text-outline">#{plan.id}</td>
                      <td className="p-3 font-bold">
                        <div className="space-y-1">
                          <div>{plan.symbol?.replace('USDT','')}</div>
                          <StructureBadges structure={plan.structure} compact />
                        </div>
                      </td>
                      <td className="p-3"><span className={`px-2 py-0.5 rounded text-[10px] font-bold ${plan.direction === 'LONG' ? 'bg-success/10 text-success' : 'bg-error/10 text-error'}`}>{plan.direction}</span></td>
                      <td className="p-3 font-mono text-[10px]">{plan.currentPrice ? `$${Number(plan.currentPrice).toLocaleString()}` : '--'}</td>
                      <td className="p-3 font-mono text-[10px]">{plan.entryPrice ? `$${Number(plan.entryPrice).toLocaleString()}` : '--'}</td>
                      <td className="p-3 font-mono text-[10px]">{plan.targetPrice ? `$${Number(plan.targetPrice).toLocaleString()}` : '--'}</td>
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          <div className="w-12 bg-surface-container-low h-1.5 rounded-full">
                            <div className="bg-success h-full rounded-full" style={{ width: `${plan.conditionsTotal > 0 ? (plan.conditionsMet / plan.conditionsTotal) * 100 : 0}%` }} />
                          </div>
                          <span className="text-[10px] font-bold">{plan.conditionsMet}/{plan.conditionsTotal}</span>
                        </div>
                      </td>
                      <td className="p-3">
                        <div className="flex gap-1 flex-wrap">
                          {plan.conditions.map((c: any, i: number) => (
                            <span key={i} className={`px-1.5 py-0.5 rounded text-[9px] font-medium ${c.met ? 'bg-success/10 text-success' : 'bg-surface-container-high text-outline'}`}>{c.field}</span>
                          ))}
                        </div>
                      </td>
                      <td className="p-3 text-outline">{plan.timeRemainingMin.toFixed(0)}분</td>
                      <td className="p-3 font-bold">{((plan.confidence || 0) * 100).toFixed(0)}%</td>
                      <td className="p-3 text-[10px] text-outline max-w-[180px] truncate" title={plan.reasoning || ''}>{plan.reasoning || '--'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* ── 우측: LLM 스트리밍 피드 ── */}
      <div className="col-span-12 lg:col-span-4">
        <LLMFeed calls={llmActive} connected={llmConnected} />
      </div>

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

/* ── LLM 피드 (우측 전체 높이) ── */

function LLMFeed({ calls, connected }: { calls: any[]; connected: boolean }) {
  const activeCnt = calls.filter(c => c.status === 'running').length;

  return (
    <div className="bg-surface-container-lowest rounded shadow-sm overflow-hidden flex flex-col sticky top-6" style={{ height: 'calc(100vh - 80px)' }}>
      {/* 헤더 */}
      <div className="p-3 border-b border-surface-container-high/30 flex items-center gap-2 flex-shrink-0">
        <span className="material-symbols-outlined text-sm text-primary">terminal</span>
        <h3 className="font-headline font-bold text-xs uppercase tracking-widest">LLM 스트리밍</h3>
        {activeCnt > 0 && (
          <>
            <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
            <span className="text-[10px] text-success font-label font-bold">{activeCnt}개 실행중</span>
          </>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-success' : 'bg-error'}`} />
          <span className={`text-[9px] font-label ${connected ? 'text-outline' : 'text-error'}`}>
            {connected ? `${calls.length}건` : 'disconnected'}
          </span>
        </span>
      </div>

      {/* 피드 */}
      <div className="flex-1 overflow-y-auto">
        {calls.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-outline/30">
            <span className="material-symbols-outlined text-4xl">psychology</span>
            <span className="text-[10px] font-label uppercase tracking-widest">LLM 대기중</span>
          </div>
        ) : (
          calls.map(call => <LLMCallBlock key={call.id} call={call} />)
        )}
      </div>
    </div>
  );
}

function LLMCallBlock({ call }: { call: any }) {
  const [promptCollapsed, setPromptCollapsed] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);
  const isRunning = call.status === 'running';
  const elapsedSec = ((call.elapsed_ms || 0) / 1000).toFixed(1);
  const taskLabel = TASK_LABELS[call.task_type] || String(call.task_type).toUpperCase().replace(/_/g, ' ');
  const badge = PROVIDER_BADGE[call.provider] || { label: call.provider, cls: 'bg-surface-container-high text-outline' };

  // 스트리밍 중 output 자동 스크롤
  useEffect(() => {
    if (outputRef.current && isRunning) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [call.output, isRunning]);

  return (
    <div className="border-b border-surface-container-high/20">
      {/* 헤더 */}
      <div className="px-3 pt-2.5 pb-1.5 flex items-center gap-1.5">
        {isRunning && <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse flex-shrink-0" />}
        <span className="text-[9px] font-bold font-label text-outline/70 uppercase tracking-wide">{taskLabel}</span>
        <span className={`px-1.5 py-0.5 rounded text-[8px] font-bold font-label ${badge.cls}`}>{badge.label}</span>
        <span className={`text-[9px] font-mono ml-auto ${isRunning ? 'text-success' : 'text-outline/40'}`}>
          {isRunning ? `⏱ ${elapsedSec}s` : `${elapsedSec}s`}
        </span>
      </div>

      {/* 프롬프트 — 항상 표시, 클릭으로 접기 */}
      <div className="px-3 pb-2">
        <button
          onClick={() => setPromptCollapsed(v => !v)}
          className="flex items-center gap-1 mb-0.5 w-full text-left"
        >
          <span className="text-[8px] font-label text-outline/50 uppercase tracking-widest">▸ PROMPT</span>
          <span className="material-symbols-outlined text-[10px] text-outline/30 ml-auto">
            {promptCollapsed ? 'expand_more' : 'expand_less'}
          </span>
        </button>
        {!promptCollapsed && (
          <pre className="text-[9px] font-mono bg-surface-container-low/80 rounded p-2 max-h-[150px] overflow-y-auto whitespace-pre-wrap break-all leading-relaxed text-on-surface-variant/60 border border-surface-container-high/20">
            {call.prompt || '(empty)'}
          </pre>
        )}
      </div>

      {/* 스트리밍 출력 */}
      <div className="px-3 pb-3">
        <div className="text-[8px] font-label text-outline/50 uppercase tracking-widest mb-0.5">
          {isRunning ? '▸ STREAMING' : '▸ OUTPUT'}
        </div>
        <pre
          ref={outputRef}
          className={`text-[9px] font-mono rounded p-2 max-h-[300px] overflow-y-auto whitespace-pre-wrap break-all leading-relaxed ${
            isRunning
              ? 'bg-success/5 border border-success/20 text-on-surface-variant'
              : 'bg-surface-container-low/50 border border-surface-container-high/15 text-on-surface-variant/60'
          }`}
        >
          {call.output || (isRunning ? '⏳ 첫 토큰 대기 중...' : '(응답 없음)')}
        </pre>
      </div>
    </div>
  );
}
