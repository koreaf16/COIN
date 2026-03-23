'use client';

import { useEffect, useState, useCallback } from 'react';

type Z0Table = 'ohlcv' | 'derivatives' | 'liquidations' | 'macro' | 'news';
type Z2Type = '' | 'sentiment' | 'briefing' | 'scenario' | 'VALIDATE_POSITION';

interface Summary {
  [key: string]: { count: number; latest: string | null; oldest: string | null };
}

export default function RealtimeDataPage() {
  // ── 탭 상태 ──
  const [activeTab, setActiveTab] = useState<'z0' | 'z2'>('z0');

  // ── Z0 ──
  const [z0Table, setZ0Table] = useState<Z0Table>('ohlcv');
  const [z0Symbol, setZ0Symbol] = useState('');
  const [z0Data, setZ0Data] = useState<any[]>([]);
  const [z0Summary, setZ0Summary] = useState<Summary>({});
  const [z0Loading, setZ0Loading] = useState(false);

  // ── Z2 ──
  const [z2Type, setZ2Type] = useState<Z2Type>('');
  const [z2Data, setZ2Data] = useState<any[]>([]);
  const [z2Detail, setZ2Detail] = useState<any>(null);
  const [z2Loading, setZ2Loading] = useState(false);

  // ── Auto-refresh ──
  const [autoRefresh, setAutoRefresh] = useState(true);

  const fetchZ0Summary = useCallback(async () => {
    try {
      const res = await fetch('/api/coin/realtime/z0-summary');
      if (res.ok) setZ0Summary(await res.json());
    } catch {}
  }, []);

  const fetchZ0Data = useCallback(async () => {
    setZ0Loading(true);
    try {
      const params = new URLSearchParams({ table: z0Table, limit: '30' });
      if (z0Symbol) params.set('symbol', z0Symbol);
      const res = await fetch(`/api/coin/realtime/z0-recent?${params}`);
      if (res.ok) setZ0Data(await res.json());
    } catch {} finally { setZ0Loading(false); }
  }, [z0Table, z0Symbol]);

  const fetchZ2Data = useCallback(async () => {
    setZ2Loading(true);
    try {
      const params = new URLSearchParams({ limit: '30' });
      if (z2Type) params.set('type', z2Type);
      const res = await fetch(`/api/coin/realtime/z2-recent?${params}`);
      if (res.ok) setZ2Data(await res.json());
    } catch {} finally { setZ2Loading(false); }
  }, [z2Type]);

  const fetchZ2Detail = async (id: number) => {
    try {
      const res = await fetch(`/api/coin/realtime/z2-detail/${id}`);
      if (res.ok) setZ2Detail(await res.json());
    } catch {}
  };

  // 초기 로드 + 자동 새로고침
  useEffect(() => {
    fetchZ0Summary();
    if (activeTab === 'z0') fetchZ0Data();
    else fetchZ2Data();
  }, [activeTab, z0Table, z0Symbol, z2Type]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => {
      fetchZ0Summary();
      if (activeTab === 'z0') fetchZ0Data();
      else fetchZ2Data();
    }, 5000);
    return () => clearInterval(timer);
  }, [autoRefresh, activeTab, fetchZ0Data, fetchZ2Data, fetchZ0Summary]);

  const fmtTs = (ts: string) => {
    if (!ts) return '-';
    const d = new Date(ts);
    return d.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  const fmtNum = (n: any, dec = 2) => {
    if (n == null || n === '') return '-';
    return Number(n).toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec });
  };

  const z0Tables: { key: Z0Table; label: string; icon: string }[] = [
    { key: 'ohlcv', label: 'OHLCV', icon: 'candlestick_chart' },
    { key: 'derivatives', label: '파생상품', icon: 'show_chart' },
    { key: 'liquidations', label: '청산', icon: 'bolt' },
    { key: 'macro', label: '매크로', icon: 'public' },
    { key: 'news', label: '뉴스', icon: 'newspaper' },
  ];

  const z2Types: { key: Z2Type; label: string }[] = [
    { key: '', label: '전체' },
    { key: 'sentiment', label: '센티먼트' },
    { key: 'briefing', label: '브리핑' },
    { key: 'scenario', label: '시나리오' },
    { key: 'VALIDATE_POSITION', label: '포지션검증' },
  ];

  const symbols = ['', 'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'LINKUSDT'];

  return (
    <div className="p-6 space-y-4">
      {/* 헤더 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-on-surface font-headline">실시간 데이터 모니터</h1>
          <p className="text-xs text-outline">Z0(수집) / Z2(분석) 데이터 파이프라인 상태</p>
        </div>
        <label className="flex items-center gap-2 text-xs text-on-surface-variant cursor-pointer">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
            className="accent-primary"
          />
          자동 새로고침 (5초)
        </label>
      </div>

      {/* Z0 Summary Cards */}
      <div className="grid grid-cols-5 gap-3">
        {z0Tables.map(t => {
          const s = z0Summary[t.key];
          return (
            <div key={t.key} className="bg-surface-container rounded-xl p-3 border border-surface-container-high/30">
              <div className="flex items-center gap-2 mb-2">
                <span className="material-symbols-outlined text-[16px] text-primary">{t.icon}</span>
                <span className="text-xs font-bold text-on-surface">{t.label}</span>
              </div>
              <div className="text-lg font-bold text-on-surface font-headline">
                {s?.count?.toLocaleString() || '0'}
              </div>
              <div className="text-[10px] text-outline mt-1">
                최근: {s?.latest ? fmtTs(s.latest) : '-'}
              </div>
            </div>
          );
        })}
      </div>

      {/* 탭 전환 */}
      <div className="flex gap-1 bg-surface-container rounded-lg p-1">
        <button
          onClick={() => setActiveTab('z0')}
          className={`flex-1 py-2 text-xs font-bold rounded-md transition-all ${
            activeTab === 'z0'
              ? 'bg-white text-on-surface shadow-sm'
              : 'text-on-surface-variant hover:text-on-surface'
          }`}
        >
          Z0 수집 데이터
        </button>
        <button
          onClick={() => setActiveTab('z2')}
          className={`flex-1 py-2 text-xs font-bold rounded-md transition-all ${
            activeTab === 'z2'
              ? 'bg-white text-on-surface shadow-sm'
              : 'text-on-surface-variant hover:text-on-surface'
          }`}
        >
          Z2 LLM 분석
        </button>
      </div>

      {/* ── Z0 탭 ── */}
      {activeTab === 'z0' && (
        <div className="space-y-3">
          {/* 필터 */}
          <div className="flex gap-2 items-center">
            <div className="flex gap-1 bg-surface-container rounded-lg p-0.5">
              {z0Tables.map(t => (
                <button
                  key={t.key}
                  onClick={() => setZ0Table(t.key)}
                  className={`px-3 py-1.5 text-[11px] font-medium rounded-md transition-all ${
                    z0Table === t.key
                      ? 'bg-primary text-on-primary'
                      : 'text-on-surface-variant hover:text-on-surface'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {(z0Table === 'ohlcv' || z0Table === 'derivatives' || z0Table === 'liquidations') && (
              <select
                value={z0Symbol}
                onChange={e => setZ0Symbol(e.target.value)}
                className="bg-surface-container text-on-surface text-xs px-2 py-1.5 rounded-lg border border-surface-container-high/50"
              >
                <option value="">전체 심볼</option>
                {symbols.filter(s => s).map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            )}
            <div className={`ml-auto text-[10px] ${z0Loading ? 'text-primary' : 'text-outline'}`}>
              {z0Loading ? '로딩...' : `${z0Data.length}건`}
            </div>
          </div>

          {/* 테이블 */}
          <div className="bg-surface-container rounded-xl border border-surface-container-high/30 overflow-hidden">
            <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
              <table className="w-full text-[11px]">
                <thead className="bg-surface-container-high/50 sticky top-0 z-10">
                  <tr>
                    {z0Table === 'ohlcv' && <>
                      <th className="text-left px-3 py-2 font-medium text-on-surface-variant">시각</th>
                      <th className="text-left px-3 py-2 font-medium text-on-surface-variant">심볼</th>
                      <th className="text-left px-3 py-2 font-medium text-on-surface-variant">TF</th>
                      <th className="text-right px-3 py-2 font-medium text-on-surface-variant">시가</th>
                      <th className="text-right px-3 py-2 font-medium text-on-surface-variant">고가</th>
                      <th className="text-right px-3 py-2 font-medium text-on-surface-variant">저가</th>
                      <th className="text-right px-3 py-2 font-medium text-on-surface-variant">종가</th>
                      <th className="text-right px-3 py-2 font-medium text-on-surface-variant">거래량</th>
                      <th className="text-right px-3 py-2 font-medium text-on-surface-variant">체결수</th>
                      <th className="text-right px-3 py-2 font-medium text-on-surface-variant">Buy</th>
                      <th className="text-right px-3 py-2 font-medium text-on-surface-variant">Sell</th>
                      <th className="text-right px-3 py-2 font-medium text-on-surface-variant">CVD</th>
                    </>}
                    {z0Table === 'derivatives' && <>
                      <th className="text-left px-3 py-2 font-medium text-on-surface-variant">시각</th>
                      <th className="text-left px-3 py-2 font-medium text-on-surface-variant">심볼</th>
                      <th className="text-right px-3 py-2 font-medium text-on-surface-variant">미결제약정</th>
                      <th className="text-right px-3 py-2 font-medium text-on-surface-variant">OI변화%</th>
                      <th className="text-right px-3 py-2 font-medium text-on-surface-variant">펀딩비</th>
                      <th className="text-right px-3 py-2 font-medium text-on-surface-variant">예측펀딩</th>
                      <th className="text-right px-3 py-2 font-medium text-on-surface-variant">롱비율</th>
                      <th className="text-right px-3 py-2 font-medium text-on-surface-variant">숏비율</th>
                      <th className="text-right px-3 py-2 font-medium text-on-surface-variant">롱청산24h</th>
                      <th className="text-right px-3 py-2 font-medium text-on-surface-variant">숏청산24h</th>
                    </>}
                    {z0Table === 'liquidations' && <>
                      <th className="text-left px-3 py-2 font-medium text-on-surface-variant">시각</th>
                      <th className="text-left px-3 py-2 font-medium text-on-surface-variant">심볼</th>
                      <th className="text-center px-3 py-2 font-medium text-on-surface-variant">방향</th>
                      <th className="text-right px-3 py-2 font-medium text-on-surface-variant">가격</th>
                      <th className="text-right px-3 py-2 font-medium text-on-surface-variant">수량</th>
                      <th className="text-right px-3 py-2 font-medium text-on-surface-variant">USD</th>
                    </>}
                    {z0Table === 'macro' && <>
                      <th className="text-left px-3 py-2 font-medium text-on-surface-variant">시각</th>
                      <th className="text-left px-3 py-2 font-medium text-on-surface-variant">지표</th>
                      <th className="text-right px-3 py-2 font-medium text-on-surface-variant">값</th>
                      <th className="text-left px-3 py-2 font-medium text-on-surface-variant">소스</th>
                    </>}
                    {z0Table === 'news' && <>
                      <th className="text-left px-3 py-2 font-medium text-on-surface-variant">시각</th>
                      <th className="text-left px-3 py-2 font-medium text-on-surface-variant">소스</th>
                      <th className="text-left px-3 py-2 font-medium text-on-surface-variant">제목</th>
                      <th className="text-left px-3 py-2 font-medium text-on-surface-variant">티커</th>
                    </>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-container-high/30">
                  {z0Data.map((row, i) => (
                    <tr key={i} className="hover:bg-surface-container-high/20 transition-colors">
                      {z0Table === 'ohlcv' && <>
                        <td className="px-3 py-1.5 text-on-surface-variant font-mono">{fmtTs(row.ts)}</td>
                        <td className="px-3 py-1.5 text-on-surface font-medium">{row.symbol}</td>
                        <td className="px-3 py-1.5 text-on-surface-variant">{row.timeframe}</td>
                        <td className="px-3 py-1.5 text-right text-on-surface font-mono">{fmtNum(row.open_price)}</td>
                        <td className="px-3 py-1.5 text-right text-on-surface font-mono">{fmtNum(row.high_price)}</td>
                        <td className="px-3 py-1.5 text-right text-on-surface font-mono">{fmtNum(row.low_price)}</td>
                        <td className="px-3 py-1.5 text-right text-on-surface font-mono font-bold">{fmtNum(row.close_price)}</td>
                        <td className="px-3 py-1.5 text-right text-on-surface-variant font-mono">{fmtNum(row.volume, 1)}</td>
                        <td className="px-3 py-1.5 text-right text-on-surface-variant font-mono">{fmtNum(row.trade_count, 0)}</td>
                        <td className="px-3 py-1.5 text-right text-green-600 font-mono">{fmtNum(row.buy_volume, 1)}</td>
                        <td className="px-3 py-1.5 text-right text-red-500 font-mono">{fmtNum(row.sell_volume, 1)}</td>
                        <td className={`px-3 py-1.5 text-right font-mono ${Number(row.cvd) >= 0 ? 'text-green-600' : 'text-red-500'}`}>{fmtNum(row.cvd, 1)}</td>
                      </>}
                      {z0Table === 'derivatives' && <>
                        <td className="px-3 py-1.5 text-on-surface-variant font-mono">{fmtTs(row.ts)}</td>
                        <td className="px-3 py-1.5 text-on-surface font-medium">{row.symbol}</td>
                        <td className="px-3 py-1.5 text-right text-on-surface font-mono">{fmtNum(row.open_interest, 0)}</td>
                        <td className={`px-3 py-1.5 text-right font-mono ${Number(row.oi_change_pct) >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                          {Number(row.oi_change_pct) >= 0 ? '+' : ''}{fmtNum(row.oi_change_pct, 4)}%
                        </td>
                        <td className="px-3 py-1.5 text-right text-on-surface font-mono">{fmtNum(Number(row.funding_rate) * 100, 4)}%</td>
                        <td className="px-3 py-1.5 text-right text-on-surface-variant font-mono">
                          {row.predicted_rate != null ? fmtNum(Number(row.predicted_rate) * 100, 4) + '%' : '-'}
                        </td>
                        <td className="px-3 py-1.5 text-right text-green-600 font-mono">{fmtNum(Number(row.long_ratio) * 100, 1)}%</td>
                        <td className="px-3 py-1.5 text-right text-red-500 font-mono">{fmtNum(Number(row.short_ratio) * 100, 1)}%</td>
                        <td className="px-3 py-1.5 text-right text-green-600 font-mono">${fmtNum(row.liq_long_24h, 0)}</td>
                        <td className="px-3 py-1.5 text-right text-red-500 font-mono">${fmtNum(row.liq_short_24h, 0)}</td>
                      </>}
                      {z0Table === 'liquidations' && <>
                        <td className="px-3 py-1.5 text-on-surface-variant font-mono">{fmtTs(row.ts)}</td>
                        <td className="px-3 py-1.5 text-on-surface font-medium">{row.symbol}</td>
                        <td className="px-3 py-1.5 text-center">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                            row.side === 'BUY' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                          }`}>{row.side}</span>
                        </td>
                        <td className="px-3 py-1.5 text-right text-on-surface font-mono">{fmtNum(row.price)}</td>
                        <td className="px-3 py-1.5 text-right text-on-surface-variant font-mono">{fmtNum(row.qty, 4)}</td>
                        <td className="px-3 py-1.5 text-right text-on-surface font-mono font-bold">${fmtNum(row.usd_value, 0)}</td>
                      </>}
                      {z0Table === 'macro' && <>
                        <td className="px-3 py-1.5 text-on-surface-variant font-mono">{fmtTs(row.ts)}</td>
                        <td className="px-3 py-1.5 text-on-surface font-bold">{row.indicator}</td>
                        <td className="px-3 py-1.5 text-right text-on-surface font-mono">{fmtNum(row.value, 4)}</td>
                        <td className="px-3 py-1.5 text-on-surface-variant">{row.source}</td>
                      </>}
                      {z0Table === 'news' && <>
                        <td className="px-3 py-1.5 text-on-surface-variant font-mono whitespace-nowrap">{fmtTs(row.ts)}</td>
                        <td className="px-3 py-1.5 text-on-surface-variant whitespace-nowrap">{row.source}</td>
                        <td className="px-3 py-1.5 text-on-surface max-w-md truncate">{row.title}</td>
                        <td className="px-3 py-1.5 text-on-surface-variant text-xs truncate max-w-[120px]">{row.tickers || '-'}</td>
                      </>}
                    </tr>
                  ))}
                  {z0Data.length === 0 && (
                    <tr><td colSpan={12} className="px-3 py-8 text-center text-on-surface-variant text-xs">데이터 없음</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── Z2 탭 ── */}
      {activeTab === 'z2' && (
        <div className="space-y-3">
          {/* 필터 */}
          <div className="flex gap-2 items-center">
            <div className="flex gap-1 bg-surface-container rounded-lg p-0.5">
              {z2Types.map(t => (
                <button
                  key={t.key}
                  onClick={() => { setZ2Type(t.key); setZ2Detail(null); }}
                  className={`px-3 py-1.5 text-[11px] font-medium rounded-md transition-all ${
                    z2Type === t.key
                      ? 'bg-primary text-on-primary'
                      : 'text-on-surface-variant hover:text-on-surface'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className={`ml-auto text-[10px] ${z2Loading ? 'text-primary' : 'text-outline'}`}>
              {z2Loading ? '로딩...' : `${z2Data.length}건`}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            {/* 리스트 */}
            <div className="col-span-2 bg-surface-container rounded-xl border border-surface-container-high/30 overflow-hidden">
              <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
                <table className="w-full text-[11px]">
                  <thead className="bg-surface-container-high/50 sticky top-0 z-10">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium text-on-surface-variant">시각</th>
                      <th className="text-left px-3 py-2 font-medium text-on-surface-variant">유형</th>
                      <th className="text-left px-3 py-2 font-medium text-on-surface-variant">소스</th>
                      <th className="text-right px-3 py-2 font-medium text-on-surface-variant">신뢰도</th>
                      <th className="text-right px-3 py-2 font-medium text-on-surface-variant">지연(ms)</th>
                      <th className="text-right px-3 py-2 font-medium text-on-surface-variant">토큰</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-surface-container-high/30">
                    {z2Data.map((row) => (
                      <tr
                        key={row.id}
                        onClick={() => fetchZ2Detail(row.id)}
                        className={`cursor-pointer transition-colors ${
                          z2Detail?.id === row.id
                            ? 'bg-primary/10'
                            : 'hover:bg-surface-container-high/20'
                        }`}
                      >
                        <td className="px-3 py-1.5 text-on-surface-variant font-mono">{fmtTs(row.ts)}</td>
                        <td className="px-3 py-1.5">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                            row.analysis_type === 'sentiment' ? 'bg-blue-100 text-blue-700' :
                            row.analysis_type === 'briefing' ? 'bg-purple-100 text-purple-700' :
                            row.analysis_type === 'scenario' ? 'bg-orange-100 text-orange-700' :
                            row.analysis_type === 'SCENARIO' ? 'bg-orange-100 text-orange-700' :
                            'bg-gray-100 text-gray-700'
                          }`}>{row.analysis_type}</span>
                        </td>
                        <td className="px-3 py-1.5 text-on-surface-variant">{row.llm_source}</td>
                        <td className="px-3 py-1.5 text-right font-mono">
                          <span className={`${Number(row.confidence) >= 0.5 ? 'text-green-600' : 'text-on-surface-variant'}`}>
                            {fmtNum(row.confidence, 2)}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-right text-on-surface-variant font-mono">{row.latency_ms ? `${Math.round(row.latency_ms)}` : '-'}</td>
                        <td className="px-3 py-1.5 text-right text-on-surface-variant font-mono">{row.token_count || '-'}</td>
                      </tr>
                    ))}
                    {z2Data.length === 0 && (
                      <tr><td colSpan={6} className="px-3 py-8 text-center text-on-surface-variant text-xs">데이터 없음</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* 상세 패널 */}
            <div className="bg-surface-container rounded-xl border border-surface-container-high/30 p-4 overflow-hidden">
              <h3 className="text-xs font-bold text-on-surface mb-3">상세 결과</h3>
              {z2Detail ? (
                <div className="space-y-2">
                  <div className="text-[10px] text-outline">
                    #{z2Detail.id} | {z2Detail.analysis_type} | {z2Detail.symbol || 'global'} | conf={fmtNum(z2Detail.confidence, 2)}
                  </div>
                  <pre className="text-[10px] text-on-surface-variant bg-surface-container-high/30 rounded-lg p-3 overflow-auto max-h-[420px] whitespace-pre-wrap break-words font-mono">
                    {typeof z2Detail.result === 'object'
                      ? JSON.stringify(z2Detail.result, null, 2)
                      : String(z2Detail.result || 'No data')}
                  </pre>
                </div>
              ) : (
                <p className="text-xs text-on-surface-variant">좌측 행을 클릭하면 상세 결과를 볼 수 있습니다.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
