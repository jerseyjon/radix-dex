// The charts draw on canvas, which cannot use CSS directly. They read the same custom
// properties that styles.css defines on :root, so the page and the charts share one palette.
// Change a colour in styles.css (the "Chart" block of :root) or styles/tokens.css and both follow.
// Custom properties defined as var(--other) come back resolved from getComputedStyle.

export interface ChartTheme {
  up: string; down: string; accent: string;
  grid: string; axis: string; text: string; strong: string;
  crosshair: string; label: string; surface: string; line: string;
  font: string;
}

/** Fallbacks match styles.css; they are only used if the stylesheet has not loaded. */
const FALLBACK: Omit<ChartTheme, 'font'> = {
  up: '#8ff0c0', down: '#ffa29d', accent: '#8ff0c0',
  grid: '#1c2640', axis: '#2b3757', text: '#c3cbdd', strong: '#e8ecf4',
  crosshair: '#6c7a9a', label: '#2b3757', surface: '#121a2e', line: 'rgba(255, 255, 255, 0.1)',
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
