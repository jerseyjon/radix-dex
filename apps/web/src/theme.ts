// The charts draw on canvas, which cannot use CSS directly. They read the same custom
// properties that styles.css defines on :root, so the page and the charts share one palette.
// Change a colour in styles.css (the "Chart" block of :root) and both follow.

export interface ChartTheme {
  up: string; down: string; accent: string;
  grid: string; axis: string; text: string; strong: string;
  crosshair: string; label: string; surface: string; line: string;
  font: string;
}

/** Fallbacks match styles.css; they are only used if the stylesheet has not loaded. */
const FALLBACK: Omit<ChartTheme, 'font'> = {
  up: '#2ebd85', down: '#f0616d', accent: '#8ea4ff',
  grid: '#161b23', axis: '#262e3a', text: '#8d97a6', strong: '#e6e9ef',
  crosshair: '#5b6575', label: '#262e3a', surface: '#10141a', line: '#1f2630',
};

const VARS: Record<keyof typeof FALLBACK, string> = {
  up: '--up', down: '--down', accent: '--accent',
  grid: '--chart-grid', axis: '--chart-axis', text: '--muted', strong: '--text',
  crosshair: '--chart-crosshair', label: '--chart-label', surface: '--surface', line: '--line',
};

export function chartTheme(el: Element): ChartTheme {
  const s = getComputedStyle(el);
  const t = { font: s.fontFamily } as ChartTheme;
  for (const k of Object.keys(VARS) as (keyof typeof VARS)[]) t[k] = s.getPropertyValue(VARS[k]).trim() || FALLBACK[k];
  return t;
}

/** Filled rectangle with rounded corners, for price tags on the axes. */
export function tag(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r = 3) {
  g.beginPath();
  if (typeof g.roundRect === 'function') g.roundRect(x, y, w, h, r);
  else g.rect(x, y, w, h);
  g.fill();
}
