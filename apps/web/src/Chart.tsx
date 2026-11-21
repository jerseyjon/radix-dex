import { useEffect, useRef } from 'react';
import type { Candle } from './api';
import { fmtAmount, pricePrecision } from './format';
import { chartTheme, tag } from './theme';

// Our own candlestick chart on a canvas: no third-party chart library, no outside links.
// Colours come from styles.css through chartTheme().
const AXIS_W = 72, AXIS_H = 22, VOL_SHARE = 0.16, MIN_BARS = 10;

interface View { bars: number; offset: number } // bars shown; bars scrolled back from the newest

export function Chart({ candles, loading }: { candles: Candle[]; loading: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const data = useRef<Candle[]>([]);
  const view = useRef<View>({ bars: 120, offset: 0 });
  const mouse = useRef<{ x: number; y: number } | undefined>(undefined);
  const shape = useRef<string>();
  const redraw = useRef<() => void>(() => {});

  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const clamp = () => {
      const n = data.current.length, v = view.current;
      v.bars = Math.max(MIN_BARS, Math.min(v.bars, Math.max(MIN_BARS, n)));
      v.offset = Math.max(0, Math.min(v.offset, Math.max(0, n - Math.ceil(v.bars / 2))));
    };
    const draw = () => {
      const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
      const g = cv.getContext('2d');
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const all = data.current;
      if (!all.length || w < AXIS_W + 40 || h < AXIS_H + 60) return;
      clamp();
      const { bars, offset } = view.current;
      const plotW = w - AXIS_W, plotH = h - AXIS_H, volH = plotH * VOL_SHARE, priceH = plotH - volH - 6;
      const step = plotW / bars, end = all.length - offset, start = Math.max(0, Math.floor(end - bars));
      const shown = all.slice(start, end);
      if (!shown.length) return;
      let lo = Infinity, hi = -Infinity, vmax = 0;
      for (const c of shown) { lo = Math.min(lo, c.low); hi = Math.max(hi, c.high); vmax = Math.max(vmax, c.volume); }
      if (hi === lo) { hi *= 1.001; lo *= 0.999; }
      const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
      const precision = pricePrecision(shown[shown.length - 1]!.close);
      const x = (i: number) => plotW - (end - (start + i) - 0.5) * step;
      const y = (p: number) => 4 + (hi - p) / (hi - lo) * priceH;

      const th = chartTheme(cv);
      g.font = '11px ' + th.font;
      g.textBaseline = 'middle';
      g.lineWidth = 1;
      // Price grid and labels.
      for (let i = 0; i <= 5; i++) {
        const p = lo + (hi - lo) * i / 5, yy = Math.round(y(p)) + 0.5;
        g.strokeStyle = th.grid; g.beginPath(); g.moveTo(0, yy); g.lineTo(plotW, yy); g.stroke();
        g.fillStyle = th.text; g.textAlign = 'left'; g.fillText(p.toFixed(precision), plotW + 8, yy);
      }
      // Time grid and labels.
      const span = shown[shown.length - 1]!.time - shown[0]!.time;
      const label = (t: number) => {
        const d = new Date(t * 1000);
        return span > 3 * 86400 ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      };
      const every = Math.max(1, Math.ceil(90 / step));
      g.textAlign = 'center';
      for (let i = shown.length - 1; i >= 0; i -= every) {
        const xx = Math.round(x(i)) + 0.5;
        g.strokeStyle = th.grid; g.beginPath(); g.moveTo(xx, 0); g.lineTo(xx, plotH); g.stroke();
        g.fillStyle = th.text; g.fillText(label(shown[i]!.time), xx, plotH + AXIS_H / 2 + 1);
      }
      g.strokeStyle = th.axis; g.beginPath(); g.moveTo(plotW + 0.5, 0); g.lineTo(plotW + 0.5, plotH + 0.5); g.lineTo(0, plotH + 0.5); g.stroke();
      // Candles and volume.
      const body = Math.max(1, Math.min(step * 0.68, 13));
      shown.forEach((c, i) => {
        const up = c.close >= c.open, xx = x(i);
        if (xx < -body || xx > plotW) return;
        g.fillStyle = g.strokeStyle = up ? th.up : th.down;
        if (vmax > 0 && c.volume > 0) { g.globalAlpha = 0.22; const vh = c.volume / vmax * volH; g.fillRect(xx - body / 2, plotH - vh, body, vh); g.globalAlpha = 1; }
        g.beginPath(); g.moveTo(Math.round(xx) + 0.5, y(c.high)); g.lineTo(Math.round(xx) + 0.5, y(c.low)); g.stroke();
        const top = y(Math.max(c.open, c.close)), bh = Math.max(1, Math.abs(y(c.open) - y(c.close)));
        g.fillRect(xx - body / 2, top, body, bh);
      });
      // Last price: a faint line across the plot and a tag on the axis.
      const last = all[all.length - 1]!;
      if (last.close >= lo && last.close <= hi) {
        const yy = Math.round(y(last.close)) + 0.5, col = last.close >= last.open ? th.up : th.down;
        g.strokeStyle = col; g.globalAlpha = 0.5; g.setLineDash([2, 3]);
        g.beginPath(); g.moveTo(0, yy); g.lineTo(plotW, yy); g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
        g.fillStyle = col; tag(g, plotW + 2, yy - 9, AXIS_W - 4, 18);
        g.fillStyle = th.surface; g.textAlign = 'left'; g.fillText(last.close.toFixed(precision), plotW + 8, yy);
      }
      // Crosshair, with tags on both axes, and the bar under it.
      const m = mouse.current;
      if (m && m.x < plotW && m.y < plotH) {
        const i = Math.max(0, Math.min(shown.length - 1, Math.round((m.x - x(0)) / step)));
        const c = shown[i]!, xx = Math.round(x(i)) + 0.5, yy = Math.round(m.y) + 0.5;
        g.strokeStyle = th.crosshair; g.setLineDash([3, 3]);
        g.beginPath(); g.moveTo(xx, 0); g.lineTo(xx, plotH); g.moveTo(0, yy); g.lineTo(plotW, yy); g.stroke(); g.setLineDash([]);
        if (m.y < 4 + priceH) {
          g.fillStyle = th.label; tag(g, plotW + 2, yy - 9, AXIS_W - 4, 18);
          g.fillStyle = th.strong; g.textAlign = 'left'; g.fillText((hi - (m.y - 4) / priceH * (hi - lo)).toFixed(precision), plotW + 8, yy);
        }
        const when = new Date(c.time * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        const tw = g.measureText(when).width + 14, tx = Math.max(0, Math.min(plotW - tw, xx - tw / 2));
        g.fillStyle = th.label; tag(g, tx, plotH + 2, tw, AXIS_H - 4);
        g.fillStyle = th.strong; g.textAlign = 'center'; g.fillText(when, tx + tw / 2, plotH + AXIS_H / 2 + 1);
        // Legend: muted letters, values in the candle's colour.
        const f = (v: number) => v.toFixed(precision), col = c.close >= c.open ? th.up : th.down;
        const parts: [string, string][] = [['O', f(c.open)], ['H', f(c.high)], ['L', f(c.low)], ['C', f(c.close)]];
        if (c.volume > 0) parts.push(['Vol', fmtAmount(c.volume)]);
        g.textAlign = 'left';
        let lx = 10;
        for (const [k, v] of parts) {
          g.fillStyle = th.text; g.fillText(k, lx, 12); lx += g.measureText(k).width + 4;
          g.fillStyle = col; g.fillText(v, lx, 12); lx += g.measureText(v).width + 12;
        }
      }
    };
    redraw.current = draw;

    const ro = new ResizeObserver(draw);
    ro.observe(cv);
    const pos = (e: MouseEvent) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    let drag: { x: number; offset: number } | undefined;
    const onMove = (e: MouseEvent) => {
      mouse.current = pos(e);
      if (drag) view.current.offset = drag.offset + (mouse.current.x - drag.x) / ((cv.clientWidth - AXIS_W) / view.current.bars);
      draw();
    };
    const onLeave = () => { mouse.current = undefined; drag = undefined; draw(); };
    const onDown = (e: MouseEvent) => { drag = { x: pos(e).x, offset: view.current.offset }; };
    const onUp = () => { drag = undefined; };
    const onWheel = (e: WheelEvent) => { e.preventDefault(); view.current.bars = view.current.bars * (e.deltaY > 0 ? 1.15 : 0.87); draw(); };
    cv.addEventListener('mousemove', onMove); cv.addEventListener('mouseleave', onLeave);
    cv.addEventListener('mousedown', onDown); window.addEventListener('mouseup', onUp);
    cv.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      ro.disconnect(); window.removeEventListener('mouseup', onUp);
      cv.removeEventListener('mousemove', onMove); cv.removeEventListener('mouseleave', onLeave);
      cv.removeEventListener('mousedown', onDown); cv.removeEventListener('wheel', onWheel);
    };
  }, []);

  useEffect(() => {
    data.current = candles;
    // Reset the view when a different data set arrives; a periodic refresh keeps the user's zoom.
    const key = candles[0]?.time + ':' + (candles.length > 0);
    if (shape.current !== key) { shape.current = key; view.current = { bars: Math.max(MIN_BARS, Math.min(candles.length, 160)), offset: 0 }; }
    redraw.current();
  }, [candles]);

  return (
    <div className="chart-wrap">
      <canvas ref={canvas} className="chart" />
      {loading && candles.length === 0 && <div className="chart-note"><span className="loader" aria-hidden="true" />Loading chart</div>}
      {loading && candles.length > 0 && <div className="chart-busy" role="status" aria-label="Loading chart" />}
      {!loading && candles.length === 0 && <div className="chart-note">No price history for this market yet</div>}
    </div>
  );
}
