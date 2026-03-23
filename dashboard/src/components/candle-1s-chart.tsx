'use client';

import { useEffect, useRef } from 'react';
import { createChart, CandlestickSeries, HistogramSeries, ColorType, type IChartApi, type ISeriesApi, LineSeries, createSeriesMarkers, type ISeriesMarkersPluginApi } from 'lightweight-charts';

interface Props {
  symbol: string;
  entryPrice?: number;
  entryTime?: number;      // epoch seconds (UTC)
  exitPrice?: number;
  exitTime?: number;        // epoch seconds (UTC)
  targetPrice?: number;
  safetyStop?: number;
  direction?: string;
}

/** UTC → ET 오프셋 (초) */
function getETOffsetSec() {
  const now = new Date();
  const utc = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return Math.round((et.getTime() - utc.getTime()) / 1000);
}

export function Candle1sChart({ symbol, entryPrice, entryTime, exitPrice, exitTime, targetPrice, safetyStop, direction }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const entryLineSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const targetLineSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const stopLineSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const exitLineSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const markersPluginRef = useRef<ISeriesMarkersPluginApi<any> | null>(null);
  const prevCountRef = useRef(0);
  const linesCreatedRef = useRef(false);

  // 차트 초기화 (1회)
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
        scaleMargins: { top: 0.08, bottom: 0.2 },
        autoScale: true,
      },
      timeScale: {
        borderColor: '#e4e9ea',
        timeVisible: true,
        secondsVisible: true,
      },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#00A650',
      downColor: '#9f403d',
      borderUpColor: '#00A650',
      borderDownColor: '#9f403d',
      wickUpColor: '#00A650',
      wickDownColor: '#9f403d',
      priceLineVisible: false,
      lastValueVisible: true,
    });

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    });
    chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });

    const makeLineSeries = (color: string, title: string) => {
      return chart.addSeries(LineSeries, {
        color,
        lineWidth: 2,
        lineStyle: 2,
        crosshairMarkerVisible: false,
        priceLineVisible: false,
        lastValueVisible: true,
        title,
      });
    };

    entryLineSeriesRef.current = makeLineSeries('#2962FF', '진입');
    targetLineSeriesRef.current = makeLineSeries('#00A650', '익절');
    stopLineSeriesRef.current = makeLineSeries('#9f403d', '손절');
    exitLineSeriesRef.current = makeLineSeries('#FF6D00', '청산');

    // 마커 플러그인 생성 (1회 — 이후 setMarkers로 업데이트)
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

    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; };
  }, []);

  // 데이터 폴링
  useEffect(() => {
    prevCountRef.current = 0;
    linesCreatedRef.current = false;

    entryLineSeriesRef.current?.setData([]);
    targetLineSeriesRef.current?.setData([]);
    stopLineSeriesRef.current?.setData([]);
    exitLineSeriesRef.current?.setData([]);
    markersPluginRef.current?.setMarkers([]);

    const tzOffset = getETOffsetSec();

    const neededSeconds = entryTime
      ? Math.min(3600, Math.max(300, Math.floor((Date.now() / 1000) - entryTime) + 300))
      : 300;

    const fetchCandles = async () => {
      try {
        const res = await fetch(`/api/coin/candles-1s/${symbol}?seconds=${neededSeconds}`);
        if (!res.ok) return;
        const data = await res.json();
        const raw = data.candles || [];
        if (!raw.length) return;

        const candles = raw.map((c: any) => ({
          time: (c.time + tzOffset) as any,
          open: c.open, high: c.high, low: c.low, close: c.close,
        }));

        const volumes = raw.map((c: any) => ({
          time: (c.time + tzOffset) as any,
          value: c.volume,
          color: c.close >= c.open ? 'rgba(0,166,80,0.3)' : 'rgba(159,64,61,0.3)',
        }));

        const firstTime = candles[0].time;
        const lastTime = candles[candles.length - 1].time;

        if (prevCountRef.current === 0) {
          candleRef.current?.setData(candles);
          volumeRef.current?.setData(volumes);

          // ── 수평 가격선 ──
          if (!linesCreatedRef.current) {
            linesCreatedRef.current = true;

            if (entryPrice && entryLineSeriesRef.current) {
              entryLineSeriesRef.current.setData([
                { time: firstTime, value: entryPrice },
                { time: lastTime, value: entryPrice },
              ]);
            }
            if (targetPrice && targetLineSeriesRef.current) {
              targetLineSeriesRef.current.setData([
                { time: firstTime, value: targetPrice },
                { time: lastTime, value: targetPrice },
              ]);
            }
            if (safetyStop && stopLineSeriesRef.current) {
              stopLineSeriesRef.current.setData([
                { time: firstTime, value: safetyStop },
                { time: lastTime, value: safetyStop },
              ]);
            }
            if (exitPrice && exitLineSeriesRef.current) {
              exitLineSeriesRef.current.setData([
                { time: firstTime, value: exitPrice },
                { time: lastTime, value: exitPrice },
              ]);
            }
          }

          // ── 마커 (진입 + 청산) ──
          const markers: any[] = [];
          const isLong = direction === 'LONG';

          // 진입 마커
          if (entryTime && candleRef.current) {
            const entryTimeET = entryTime + tzOffset;
            let markerTime = candles[0].time;
            let minDiff = Infinity;
            for (const c of candles) {
              const diff = Math.abs((c.time as number) - entryTimeET);
              if (diff < minDiff) { minDiff = diff; markerTime = c.time; }
            }

            const etStr = new Date(entryTime * 1000).toLocaleString('en-US', {
              timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
            });

            markers.push({
              time: markerTime,
              position: isLong ? 'belowBar' : 'aboveBar',
              color: '#2962FF',
              shape: isLong ? 'arrowUp' : 'arrowDown',
              text: `▶ 진입 $${entryPrice || ''} ${etStr}`,
              size: 2,
            });
          }

          // 청산 마커
          if (exitTime && candleRef.current) {
            const exitTimeET = exitTime + tzOffset;
            let markerTime = candles[candles.length - 1].time;
            let minDiff = Infinity;
            for (const c of candles) {
              const diff = Math.abs((c.time as number) - exitTimeET);
              if (diff < minDiff) { minDiff = diff; markerTime = c.time; }
            }

            const etStr = new Date(exitTime * 1000).toLocaleString('en-US', {
              timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
            });

            markers.push({
              time: markerTime,
              position: isLong ? 'aboveBar' : 'belowBar',
              color: '#FF6D00',
              shape: isLong ? 'arrowDown' : 'arrowUp',
              text: `■ 청산 $${exitPrice || ''} ${etStr}`,
              size: 2,
            });
          }

          // 시간순 정렬 후 마커 세팅
          markers.sort((a, b) => (a.time as number) - (b.time as number));
          if (markers.length && markersPluginRef.current) {
            markersPluginRef.current.setMarkers(markers);
          }

          // 스크롤
          if (entryTime && chartRef.current && candles.length > 0) {
            const entryTimeET = entryTime + tzOffset;
            const from = entryTimeET - 60;
            const to = lastTime as number;
            try {
              chartRef.current.timeScale().setVisibleRange({ from: from as any, to: to as any });
            } catch {
              chartRef.current.timeScale().scrollToRealTime();
            }
          } else {
            chartRef.current?.timeScale().scrollToRealTime();
          }
        } else {
          // 증분 업데이트
          const startIdx = Math.max(0, candles.length - 3);
          for (let i = startIdx; i < candles.length; i++) {
            candleRef.current?.update(candles[i]);
            volumeRef.current?.update(volumes[i]);
          }
          // 라인 끝점 연장
          if (entryPrice) entryLineSeriesRef.current?.update({ time: lastTime, value: entryPrice });
          if (targetPrice) targetLineSeriesRef.current?.update({ time: lastTime, value: targetPrice });
          if (safetyStop) stopLineSeriesRef.current?.update({ time: lastTime, value: safetyStop });
          if (exitPrice) exitLineSeriesRef.current?.update({ time: lastTime, value: exitPrice });
        }

        prevCountRef.current = candles.length;
      } catch {}
    };

    fetchCandles();
    const timer = setInterval(fetchCandles, 1000);
    return () => clearInterval(timer);
  }, [symbol, entryPrice, entryTime, exitPrice, exitTime, targetPrice, safetyStop, direction]);

  return <div ref={containerRef} className="w-full h-full" />;
}
