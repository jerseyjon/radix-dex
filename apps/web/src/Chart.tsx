import { useEffect, useRef } from 'react';
import { ColorType, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import type { Candle } from './api';
import { pricePrecision } from './format';

export function Chart({ candles, loading }: { candles: Candle[]; loading: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi>();
  const price = useRef<ISeriesApi<'Candlestick'>>();
  const volume = useRef<ISeriesApi<'Histogram'>>();
  const fitted = useRef<string>();

  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#7a8494', fontFamily: 'inherit', fontSize: 11 },
      grid: { vertLines: { color: '#171c25' }, horzLines: { color: '#171c25' } },
      rightPriceScale: { borderColor: '#1e2430' },
      timeScale: { borderColor: '#1e2430', timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
    });
    price.current = c.addCandlestickSeries({ upColor: '#1fbf8f', downColor: '#f0506e', borderVisible: false, wickUpColor: '#1fbf8f', wickDownColor: '#f0506e' });
    volume.current = c.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol', color: '#2a3342' });
    c.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chart.current = c;
    return () => { c.remove(); chart.current = undefined; };
  }, []);

  useEffect(() => {
    if (!price.current || !volume.current) return;
    const last = candles[candles.length - 1]?.close ?? 1;
    const precision = pricePrecision(last);
    price.current.applyOptions({ priceFormat: { type: 'price', precision, minMove: 10 ** -precision } });
    price.current.setData(candles.map((c) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close })));
    volume.current.setData(candles.map((c) => ({ time: c.time as UTCTimestamp, value: c.volume, color: c.close >= c.open ? '#1fbf8f55' : '#f0506e55' })));
    // Fit once per data set of a different shape, so a periodic refresh does not undo the user's zoom.
    if (fitted.current !== candles[0]?.time + ':' + (candles.length > 0)) { chart.current?.timeScale().fitContent(); fitted.current = candles[0]?.time + ':' + (candles.length > 0); }
  }, [candles]);

  return (
    <div className="chart-wrap">
      <div ref={el} className="chart" />
      {loading && <div className="chart-note">Loading chart…</div>}
      {!loading && candles.length === 0 && <div className="chart-note">No price history for this market yet</div>}
    </div>
  );
}
