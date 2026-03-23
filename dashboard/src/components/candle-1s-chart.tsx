'use client';

import { useEffect, useRef } from 'react';
import { createChart, CandlestickSeries, HistogramSeries, ColorType, type IChartApi, type ISeriesApi, LineSeries } from 'lightweight-charts';

interface Props {
  symbol: string;
  entryPrice?: number;
  entryTime?: number;      // epoch seconds (UTC)
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

export function Candle1sChart({ symbol, entryPrice, entryTime, targetPrice, safetyStop, direction }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  // 가격 라인용 보이지 않는 LineSeries (Y축 범위 강제 확장)
  const entryLineSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const targetLineSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const stopLineSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const prevCountRef = useRef(0);
  const markersSetRef = useRef(false);
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
        scaleMargins: { top: 0.05, bottom: 0.2 },
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

    // 가격 라인용 LineSeries (수평선 표시 — Y축 범위에 자동 포함됨)
    const makeLineSeries = (color: string, title: string) => {
      const s = chart.addSeries(LineSeries, {
        color,
        lineWidth: 2,
        lineStyle: 2, // dashed
        crosshairMarkerVisible: false,
        priceLineVisible: false,
        lastValueVisible: true,
        title,
      });
      return s;
    };

    entryLineSeriesRef.current = makeLineSeries('#2962FF', '진입');
    targetLineSeriesRef.current = makeLineSeries('#00A650', '익절');
    stopLineSeriesRef.current = makeLineSeries('#9f403d', '손절');

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

  // 데이터 폴링 (심볼 변경 시 리셋)
  useEffect(() => {
    prevCountRef.current = 0;
    markersSetRef.current = false;
    linesCreatedRef.current = false;

    // 기존 라인 데이터 클리어
    entryLineSeriesRef.current?.setData([]);
    targetLineSeriesRef.current?.setData([]);
    stopLineSeriesRef.current?.setData([]);

    const tzOffset = getETOffsetSec();

    // 진입 5분 전부터 현재까지 필요한 초 수 계산 (최소 300초, 최대 3600초)
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
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        }));

        const volumes = raw.map((c: any) => ({
          time: (c.time + tzOffset) as any,
          value: c.volume,
          color: c.close >= c.open ? 'rgba(0,166,80,0.3)' : 'rgba(159,64,61,0.3)',
        }));

        if (prevCountRef.current === 0) {
          // 최초 로드: 전체 세팅
          candleRef.current?.setData(candles);
          volumeRef.current?.setData(volumes);

          // ── 수평 가격 라인 (LineSeries로 — Y축 범위 자동 포함) ──
          if (!linesCreatedRef.current) {
            linesCreatedRef.current = true;
            const firstTime = candles[0].time;
            const lastTime = candles[candles.length - 1].time;

            // 진입가
            if (entryPrice && entryLineSeriesRef.current) {
              entryLineSeriesRef.current.setData([
                { time: firstTime, value: entryPrice },
                { time: lastTime, value: entryPrice },
              ]);
            }
            // 익절가
            if (targetPrice && targetLineSeriesRef.current) {
              targetLineSeriesRef.current.setData([
                { time: firstTime, value: targetPrice },
                { time: lastTime, value: targetPrice },
              ]);
            }
            // 손절가
            if (safetyStop && stopLineSeriesRef.current) {
              stopLineSeriesRef.current.setData([
                { time: firstTime, value: safetyStop },
                { time: lastTime, value: safetyStop },
              ]);
            }
          } else {
            // 증분: 라인 끝점 연장
            const lastTime = candles[candles.length - 1].time;
            if (entryPrice && entryLineSeriesRef.current) {
              entryLineSeriesRef.current.update({ time: lastTime, value: entryPrice });
            }
            if (targetPrice && targetLineSeriesRef.current) {
              targetLineSeriesRef.current.update({ time: lastTime, value: targetPrice });
            }
            if (safetyStop && stopLineSeriesRef.current) {
              stopLineSeriesRef.current.update({ time: lastTime, value: safetyStop });
            }
          }

          // ── 진입 마커 ──
          if (entryTime && candleRef.current && !markersSetRef.current) {
            const entryTimeET = entryTime + tzOffset;
            let markerTime = candles[0]?.time;
            let minDiff = Infinity;
            for (const c of candles) {
              const diff = Math.abs((c.time as number) - entryTimeET);
              if (diff < minDiff) { minDiff = diff; markerTime = c.time; }
            }

            const isLong = direction === 'LONG';
            const entryDate = new Date(entryTime * 1000);
            const etStr = entryDate.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

            candleRef.current.setMarkers([{
              time: markerTime,
              position: isLong ? 'belowBar' : 'aboveBar',
              color: '#2962FF',
              shape: isLong ? 'arrowUp' : 'arrowDown',
              text: `진입 ${etStr} ET`,
            }]);
            markersSetRef.current = true;
          }

          // 스크롤: 진입 시점 앞부터
          if (entryTime && chartRef.current && candles.length > 0) {
            const entryTimeET = entryTime + tzOffset;
            const from = entryTimeET - 60;
            const to = candles[candles.length - 1].time as number;
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
          const lastTime = candles[candles.length - 1].time;
          if (entryPrice) entryLineSeriesRef.current?.update({ time: lastTime, value: entryPrice });
          if (targetPrice) targetLineSeriesRef.current?.update({ time: lastTime, value: targetPrice });
          if (safetyStop) stopLineSeriesRef.current?.update({ time: lastTime, value: safetyStop });
        }

        prevCountRef.current = candles.length;
      } catch {}
    };

    fetchCandles();
    const timer = setInterval(fetchCandles, 1000);
    return () => clearInterval(timer);
  }, [symbol, entryPrice, entryTime, targetPrice, safetyStop, direction]);

  return <div ref={containerRef} className="w-full h-full" />;
}
