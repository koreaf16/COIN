'use client';

import { useEffect, useRef, useState } from 'react';
import { createChart, CandlestickSeries, HistogramSeries, LineSeries, ColorType, type IChartApi, type ISeriesApi, createSeriesMarkers } from 'lightweight-charts';

interface Props {
  positionId: number;
  onClose?: () => void;
}

/** UTC → ET 오프셋 (초) */
function getETOffsetSec() {
  const now = new Date();
  const utc = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return Math.round((et.getTime() - utc.getTime()) / 1000);
}

export function TradeReplayChart({ positionId, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [meta, setMeta] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/coin/positions/${positionId}/candles`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        if (!data.candles?.length) {
          setError('1초봉 데이터 없음 (아직 캡처되지 않았거나 이전 거래)');
          setLoading(false);
          return;
        }
        setMeta(data);
        setLoading(false);
      } catch (err: any) {
        if (!cancelled) { setError(err.message); setLoading(false); }
      }
    };

    load();
    return () => { cancelled = true; };
  }, [positionId]);

  // 차트 렌더링
  useEffect(() => {
    if (!meta?.candles?.length || !containerRef.current) return;

    const tzOffset = getETOffsetSec();
    const rawCandles = meta.candles;

    // createChart 전에 처리 — 빈 배열이면 차트 생성 없이 리턴
    const candles = rawCandles
      .map((c: any) => ({
        time: (Math.floor(Number(c.time)) + tzOffset) as any,
        open: c.open, high: c.high, low: c.low, close: c.close,
      }))
      .filter((c: any) => isFinite(c.time));

    const volumes = rawCandles
      .map((c: any) => ({
        time: (Math.floor(Number(c.time)) + tzOffset) as any,
        value: c.volume ?? 0,
        color: c.close >= c.open ? 'rgba(0,166,80,0.3)' : 'rgba(159,64,61,0.3)',
      }))
      .filter((c: any) => isFinite(c.time));

    if (!candles.length) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#ffffff' },
        textColor: '#5a6061',
        fontFamily: 'Space Grotesk',
        fontSize: 10,
      },
      grid: {
        vertLines: { color: '#f2f4f4' },
        horzLines: { color: '#f2f4f4' },
      },
      crosshair: {
        vertLine: { color: '#adb3b4', width: 1, style: 2, labelBackgroundColor: '#4f6073' },
        horzLine: { color: '#adb3b4', width: 1, style: 2, labelBackgroundColor: '#4f6073' },
      },
      rightPriceScale: {
        borderColor: '#e4e9ea',
        scaleMargins: { top: 0.05, bottom: 0.2 },
        autoScale: true,
      },
      timeScale: {
        borderColor: '#e4e9ea',
        timeVisible: true,
        secondsVisible: true,
      },
    });
    chartRef.current = chart;

    // 캔들스틱
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#00A650',
      downColor: '#9f403d',
      borderUpColor: '#00A650',
      borderDownColor: '#9f403d',
      wickUpColor: '#00A650',
      wickDownColor: '#9f403d',
      priceLineVisible: false,
      lastValueVisible: false,
    });

    candleSeries.setData(candles);

    // 볼륨
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    });
    chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });
    volumeSeries.setData(volumes);

    // ── 수평 가격선 (LineSeries) ──
    const firstTime = candles[0].time;
    const lastTime = candles.length > 1 ? candles[candles.length - 1].time : (firstTime as number) + 1;

    const makeLine = (price: number, color: string, title: string) => {
      const s = chart.addSeries(LineSeries, {
        color,
        lineWidth: 2,
        lineStyle: 2,
        crosshairMarkerVisible: false,
        priceLineVisible: false,
        lastValueVisible: true,
        title,
      });
      s.setData([
        { time: firstTime, value: price },
        { time: lastTime, value: price },
      ]);
    };

    // 진입가 (파란 점선)
    if (meta.entryPrice) makeLine(meta.entryPrice, '#2962FF', '진입');

    // 청산가 (주황 점선)
    if (meta.exitPrice) makeLine(meta.exitPrice, '#FF6D00', '청산');

    // 익절가 (녹색 점선)
    if (meta.targetPrice) makeLine(meta.targetPrice, '#00A650', '익절');

    // 손절가 (빨간 점선)
    if (meta.safetyStop) makeLine(meta.safetyStop, '#9f403d', '손절');

    // ── 마커: 진입 & 청산 시점 ──
    const markers: any[] = [];

    if (meta.entryTime) {
      const entryTimeET = meta.entryTime + tzOffset;
      let markerTime = candles[0].time;
      let minDiff = Infinity;
      for (const c of candles) {
        const diff = Math.abs((c.time as number) - entryTimeET);
        if (diff < minDiff) { minDiff = diff; markerTime = c.time; }
      }
      const isLong = meta.direction === 'LONG';
      const etStr = new Date(meta.entryTime * 1000).toLocaleString('en-US', {
        timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
      });
      markers.push({
        time: markerTime,
        position: isLong ? 'belowBar' : 'aboveBar',
        color: '#2962FF',
        shape: isLong ? 'arrowUp' : 'arrowDown',
        text: `진입 ${etStr}`,
      });
    }

    if (meta.exitTime) {
      const exitTimeET = meta.exitTime + tzOffset;
      let markerTime = candles[candles.length - 1].time;
      let minDiff = Infinity;
      for (const c of candles) {
        const diff = Math.abs((c.time as number) - exitTimeET);
        if (diff < minDiff) { minDiff = diff; markerTime = c.time; }
      }
      const isLong = meta.direction === 'LONG';
      const etStr = new Date(meta.exitTime * 1000).toLocaleString('en-US', {
        timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
      });
      markers.push({
        time: markerTime,
        position: isLong ? 'aboveBar' : 'belowBar',
        color: '#FF6D00',
        shape: isLong ? 'arrowDown' : 'arrowUp',
        text: `청산 ${etStr}`,
      });
    }

    // 시간순 정렬 필수
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    if (markers.length) createSeriesMarkers(candleSeries, markers);

    // 스크롤: 진입 시점이 캔들 범위 안에 있으면 진입 1분전부터, 아니면 전체 표시
    if (meta.entryTime) {
      const entryTimeET = meta.entryTime + tzOffset;
      const candleFirst = candles[0].time as number;
      const candleLast = candles[candles.length - 1].time as number;
      if (entryTimeET >= candleFirst && entryTimeET <= candleLast + 60) {
        try {
          chart.timeScale().setVisibleRange({ from: (entryTimeET - 60) as any, to: candleLast as any });
        } catch { chart.timeScale().fitContent(); }
      } else {
        chart.timeScale().fitContent();
      }
    } else {
      chart.timeScale().fitContent();
    }

    // 리사이즈
    const ro = new ResizeObserver(() => {
      if (containerRef.current) {
        chart.applyOptions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
      }
    });
    ro.observe(containerRef.current);

    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; };
  }, [meta]);

  const pnlColor = (meta?.exitPrice && meta?.entryPrice)
    ? ((meta.direction === 'LONG' ? 1 : -1) * (meta.exitPrice - meta.entryPrice) >= 0 ? '#00A650' : '#9f403d')
    : '#888';

  return (
    <div className="bg-surface-container-lowest rounded shadow-sm overflow-hidden">
      <div className="p-3 border-b border-surface-container-high/30 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-sm text-primary">candlestick_chart</span>
          <h3 className="font-headline font-bold text-xs uppercase tracking-widest">
            {meta?.symbol?.replace('USDT', '')}
          </h3>
          {meta?.direction && (
            <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${meta.direction === 'LONG' ? 'bg-success/10 text-success' : 'bg-error/10 text-error'}`}>
              {meta.direction}
            </span>
          )}
          <span className="text-[10px] font-label text-outline">1초봉 리플레이</span>
        </div>
        <div className="flex items-center gap-3">
          {meta?.entryPrice && <span className="text-[10px]">진입 <b className="text-[#2962FF]">${meta.entryPrice}</b></span>}
          {meta?.exitPrice && <span className="text-[10px]">청산 <b style={{ color: pnlColor }}>${meta.exitPrice}</b></span>}
          {meta?.targetPrice && <span className="text-[10px]">목표 <b className="text-success">${meta.targetPrice}</b></span>}
          {meta?.safetyStop && <span className="text-[10px]">손절 <b className="text-error">${meta.safetyStop}</b></span>}
          {onClose && (
            <button onClick={onClose} className="text-outline hover:text-on-surface text-sm">
              <span className="material-symbols-outlined text-sm">close</span>
            </button>
          )}
        </div>
      </div>
      {loading && <div className="p-8 text-center text-outline text-xs">로딩 중...</div>}
      {error && <div className="p-8 text-center text-outline text-xs">{error}</div>}
      {!loading && !error && <div ref={containerRef} className="w-full h-[350px]" />}
    </div>
  );
}
