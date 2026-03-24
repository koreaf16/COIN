'use client';

import { useEffect, useRef } from 'react';
import { createChart, CandlestickSeries, HistogramSeries, ColorType, type IChartApi, type ISeriesApi, createSeriesMarkers, type ISeriesMarkersPluginApi } from 'lightweight-charts';

interface Kline {
  ts: string;
  open_price: number;
  high_price: number;
  low_price: number;
  close_price: number;
  volume: number;
}

interface Props {
  symbol: string;
  timeframe: string;
  entryFocus?: { entryTime: number; entryPrice: number } | null;
}

/** UTC → ET 오프셋 (초). EST=-18000, EDT=-14400 자동 전환 */
function getETOffsetSec() {
  const now = new Date();
  const utc = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return Math.round((et.getTime() - utc.getTime()) / 1000);
}

export function CandleChart({ symbol, timeframe, entryFocus }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const entryLineRef = useRef<any>(null); // 진입가 라인 참조 (중복 방지)
  const markersPluginRef = useRef<ISeriesMarkersPluginApi<any> | null>(null); // 마커 플러그인 (1회 생성, 재사용)
  const focusAppliedRef = useRef(false);  // 포커스 1회만 적용

  useEffect(() => {
    if (!containerRef.current) return;

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
        scaleMargins: { top: 0.1, bottom: 0.25 },
      },
      timeScale: {
        borderColor: '#e4e9ea',
        timeVisible: true,
        secondsVisible: false,
      },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#00A650',
      downColor: '#9f403d',
      borderUpColor: '#00A650',
      borderDownColor: '#9f403d',
      wickUpColor: '#00A650',
      wickDownColor: '#9f403d',
    });

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    });

    chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });

    // 마커 플러그인 1회 생성 — 이후 setMarkers로 재사용
    markersPluginRef.current = createSeriesMarkers(candleSeries, []);

    chartRef.current = chart;
    candleRef.current = candleSeries;
    volumeRef.current = volumeSeries;

    const ro = new ResizeObserver(() => {
      if (containerRef.current) {
        chart.applyOptions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
      entryLineRef.current = null;
      markersPluginRef.current = null;
    };
  }, []);

  // symbol/timeframe/entryFocus 변경 시 포커스 플래그 리셋
  useEffect(() => {
    focusAppliedRef.current = false;
    // 이전 진입가 라인 제거
    if (entryLineRef.current && candleRef.current) {
      try { candleRef.current.removePriceLine(entryLineRef.current); } catch {}
      entryLineRef.current = null;
    }
    // 이전 마커 초기화 — 누적 방지
    markersPluginRef.current?.setMarkers([]);
  }, [symbol, timeframe, entryFocus]);

  useEffect(() => {
    let cancelled = false;
    const tfMap: Record<string, string> = { '1M': '1m', '5M': '5m', '15M': '15m', '1H': '1h', '4H': '4h' };
    const tf = tfMap[timeframe] || '1m';
    const tzOffset = getETOffsetSec();

    const loadData = async () => {
      try {
        const res = await fetch(`/api/coin/klines/${symbol}?timeframe=${tf}&limit=200`);
        if (cancelled || !res.ok) return;
        const klines: Kline[] = await res.json();
        if (cancelled) return;
        if (!klines.length) return;

        const candles = klines
          .map(k => {
            const t = Math.floor(new Date(k.ts).getTime() / 1000);
            return { time: (t + tzOffset) as any, open: k.open_price, high: k.high_price, low: k.low_price, close: k.close_price };
          })
          .filter(c => isFinite(c.time));

        const volumes = klines
          .map(k => {
            const t = Math.floor(new Date(k.ts).getTime() / 1000);
            return {
              time: (t + tzOffset) as any,
              value: k.volume ?? 0,
              color: k.close_price >= k.open_price ? 'rgba(0,166,80,0.3)' : 'rgba(159,64,61,0.3)',
            };
          })
          .filter(c => isFinite(c.time));

        if (!candles.length) return;

        candleRef.current?.setData(candles);
        volumeRef.current?.setData(volumes);

        // 진입 포커스 — 첫 로드에만 1회 적용
        if (entryFocus && chartRef.current && candleRef.current && !focusAppliedRef.current) {
          focusAppliedRef.current = true;

          const entryLocal = entryFocus.entryTime + tzOffset;
          const nowLocal = Math.floor(Date.now() / 1000) + tzOffset;
          const from = entryLocal - 300;
          const span = nowLocal - from;
          const minSpan = Math.max(span, 3600);
          const to = from + Math.floor(minSpan * 1.1);
          chartRef.current.timeScale().setVisibleRange({ from: from as any, to: to as any });

          // 진입가 수평선 (1회)
          try {
            entryLineRef.current = candleRef.current.createPriceLine({
              price: entryFocus.entryPrice,
              color: '#2962FF',
              lineWidth: 2,
              lineStyle: 2,
              axisLabelVisible: true,
              title: `진입 $${entryFocus.entryPrice}`,
            });
          } catch (err) {
            console.error('[CandleChart] createPriceLine error:', err);
          }

          // 진입 시점 마커 (플러그인 재사용 — 누적 방지)
          try {
            const entryTs = Math.floor(entryLocal / 60) * 60;
            const etTime = new Date(entryFocus.entryTime * 1000)
              .toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });
            markersPluginRef.current?.setMarkers([{
              time: entryTs as any,
              position: 'belowBar',
              color: '#2962FF',
              shape: 'arrowUp',
              text: `진입 ${etTime} ET`,
            }]);
          } catch (err) {
            console.error('[CandleChart] setMarkers error:', err);
          }
        }
      } catch (err) {
        if (!cancelled) console.error('[CandleChart] loadData error:', err);
      }
    };

    loadData();
    const timer = setInterval(loadData, 10000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [symbol, timeframe, entryFocus]);

  return <div ref={containerRef} className="w-full h-full" />;
}
