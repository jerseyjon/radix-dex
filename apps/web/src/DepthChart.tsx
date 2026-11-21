import { useEffect, useRef } from 'react';
import type { Depth } from '@radix-dex/core/browser';
import { fmtAmount, fmtPrice } from './format';
import { chartTheme, tag } from './theme';

// Cumulative depth on a canvas: bids stepping down to the left of the mid price, asks stepping up to the right.
// Colours come from styles.css through chartTheme().
const AXIS_W = 72, AXIS_H = 22, PAD_TOP = 14;

interface Step { price: number; total: number }
const cumulate = (levels: { price: number; size: number }[]): Step[] => {
  let total = 0;
  return levels.map((l) => ({ price: l.price, total: (total += l.size) }));
};

export function DepthChart({ depth, baseSymbol, onPick }: { depth: Depth | undefined; baseSymbol: string; onPick: (price: number) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const data = useRef<Depth | undefined>(depth);
  const mouse = useRef<{ x: number } | undefined>(undefined);
  const redraw = useRef<() => void>(() => {});
  const scale = useRef<{ lo: number; hi: number; plotW: number } | undefined>(undefined);

  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
      const g = cv.getContext('2d');
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      scale.current = undefined;
      const d = data.current, mid = d?.mid;
      if (!d || !mid || w < AXIS_W + 60 || h < AXIS_H + 60) return;
      const bids = cumulate(d.bids), asks = cumulate(d.asks);
      if (!bids.length && !asks.length) return;
      // The same distance either side of the mid, far enough to show the shallower side whole.
      const reach = Math.max(1e-12, Math.min(
        bids.length ? mid - bids[bids.length - 1]!.price : Infinity,
        asks.length ? asks[asks.length - 1]!.price - mid : Infinity,
      ) * 1.05);
      const lo = Math.max(0, mid - reach), hi = mid + reach;
      const inView = (s: Step) => s.price >= lo && s.price <= hi;
      const top = Math.max(...bids.filter(inView).map((s) => s.total), ...asks.filter(inView).map((s) => s.total), 1e-18) * 1.08;
      const plotW = w - AXIS_W, plotH = h - AXIS_H;
      scale.current = { lo, hi, plotW };
      const x = (p: number) => ((p - lo) / (hi - lo)) * plotW;
      const y = (t: number) => plotH - (t / top) * (plotH - PAD_TOP);

      const th = chartTheme(cv);
      g.font = '11px ' + th.font;
      g.textBaseline = 'middle';
      g.lineWidth = 1;
      for (let i = 1; i <= 4; i++) {
        const t = (top / 1.08) * (i / 4), yy = Math.round(y(t)) + 0.5;
        g.strokeStyle = th.grid; g.beginPath(); g.moveTo(0, yy); g.lineTo(plotW, yy); g.stroke();
        g.fillStyle = th.text; g.textAlign = 'left'; g.fillText(fmtAmount(t), plotW + 8, yy);
      }
      g.textAlign = 'center';
      for (let i = 0; i <= 4; i++) {
        const p = lo + ((hi - lo) * i) / 4, xx = Math.min(plotW - 30, Math.max(30, x(p)));
        g.fillStyle = th.text; g.fillText(fmtPrice(p), xx, plotH + AXIS_H / 2 + 1);
      }
      g.strokeStyle = th.axis; g.beginPath(); g.moveTo(0, plotH + 0.5); g.lineTo(w, plotH + 0.5); g.moveTo(plotW + 0.5, 0); g.lineTo(plotW + 0.5, plotH); g.stroke();

      // A level's size is on offer from the previous level's price out to its own: draw each as a step.
      const area = (steps: Step[], colour: string) => {
        if (!steps.length) return;
        g.beginPath();
        let px = x(mid);
        g.moveTo(px, y(0));
        let total = 0;
        for (const s of steps) {
          // Past the edge of the view: carry the last total out to the edge and stop.
          if (!inView(s)) { px = s.price < mid ? 0 : plotW; g.lineTo(px, y(total)); break; }
          const sx = x(s.price);
          g.lineTo(px, y(s.total)); g.lineTo(sx, y(s.total));
          px = sx; total = s.total;
        }
        g.strokeStyle = colour; g.lineWidth = 1.5; g.stroke(); g.lineWidth = 1;
        g.lineTo(px, y(0)); g.closePath();
        g.globalAlpha = 0.12; g.fillStyle = colour; g.fill(); g.globalAlpha = 1;
      };
      area(bids, th.up);
      area(asks, th.down);

      g.setLineDash([2, 3]); g.strokeStyle = th.crosshair; g.beginPath(); g.moveTo(Math.round(x(mid)) + 0.5, 0); g.lineTo(Math.round(x(mid)) + 0.5, plotH); g.stroke(); g.setLineDash([]);

      const m = mouse.current;
      if (m && m.x >= 0 && m.x <= plotW) {
        const price = lo + (m.x / plotW) * (hi - lo);
        const side = price < mid ? bids : asks;
        const reached = side.filter((s) => (price < mid ? s.price >= price : s.price <= price)).at(-1);
        const total = reached?.total ?? 0;
        g.strokeStyle = th.crosshair; g.setLineDash([3, 3]);
        g.beginPath(); g.moveTo(Math.round(m.x) + 0.5, 0); g.lineTo(Math.round(m.x) + 0.5, plotH); g.stroke(); g.setLineDash([]);
        const label = `${fmtPrice(price)}  ·  ${fmtAmount(total)} ${baseSymbol}`;
        const tw = g.measureText(label).width + 16, lx = Math.max(4, Math.min(plotW - tw - 4, m.x - tw / 2));
        g.fillStyle = th.label; tag(g, lx, 6, tw, 22, 4);
        g.fillStyle = price < mid ? th.up : th.down; g.fillRect(lx, 10, 2, 14);
        g.fillStyle = th.strong; g.textAlign = 'left'; g.fillText(label, lx + 8, 17);
      }
    };
    redraw.current = draw;
    const ro = new ResizeObserver(draw);
    ro.observe(cv);
    const move = (e: MouseEvent) => { mouse.current = { x: e.clientX - cv.getBoundingClientRect().left }; draw(); };
    const leave = () => { mouse.current = undefined; draw(); };
    const click = (e: MouseEvent) => {
      const s = scale.current;
      if (!s) return;
      const px = e.clientX - cv.getBoundingClientRect().left;
      if (px >= 0 && px <= s.plotW) onPick(s.lo + (px / s.plotW) * (s.hi - s.lo));
    };
    cv.addEventListener('mousemove', move); cv.addEventListener('mouseleave', leave); cv.addEventListener('click', click);
    draw();
    return () => { ro.disconnect(); cv.removeEventListener('mousemove', move); cv.removeEventListener('mouseleave', leave); cv.removeEventListener('click', click); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseSymbol]);

  useEffect(() => { data.current = depth; redraw.current(); }, [depth]);

  const empty = depth && !depth.bids.length && !depth.asks.length;
  return (
    <div className="chart-wrap">
      <canvas ref={canvas} className="chart" aria-label="Depth chart: cumulative size on offer at each price" />
      {!depth && <div className="chart-note"><span className="loader" aria-hidden="true" />Loading depth</div>}
      {empty && <div className="chart-note">No liquidity found for this market</div>}
    </div>
  );
}
