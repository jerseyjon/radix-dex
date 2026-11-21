# Design overhaul, 21 Nov 2026

Branch `design-overhaul`. Presentation only: no change to data flow, API calls, wallet logic,
order building or validation. Screenshots in this folder, `before-*` and `after-*`, at
1750 and 1280 px (desktop), 900 px (tablet) and 390 px (phone), taken from a local preview
against the live read APIs. No wallet is connected in them.

## Design system

All tokens are CSS custom properties on `:root` in `apps/web/src/styles.css`. The canvas
charts read the same properties through `apps/web/src/theme.ts`, so one edit changes both.

**Palette (dark)**

| Token | Value | Use |
|---|---|---|
| `--bg` | `#0a0d12` | page, inputs |
| `--surface` | `#10141a` | panels |
| `--surface-2` / `-3` | `#161b23` / `#1c222c` | raised, hover |
| `--line` / `--line-2` | `#1f2630` / `#2a3240` | borders, control borders |
| `--text` | `#e6e9ef` | primary text (15:1 on panels) |
| `--text-2` | `#aab3c0` | secondary values (8.7:1) |
| `--muted` | `#8d97a6` | labels (6.2:1 on panels, at least 5.4:1 on every surface: passes AA) |
| `--faint` | `#5d6776` | decoration and placeholders only |
| `--accent` | `#8ea4ff` | the one accent: selection, focus, links, tabs |
| `--up` / `--down` | `#2ebd85` / `#f0616d` | buy / sell (7.7:1 and 5.8:1 on panels); dark text on solid fills |
| `--warn` | `#e8b45a` | the audit banner, warnings |

Soft tints (`--up-soft`, `--down-soft`, `--accent-soft`, `--warn-soft`) are the same hues at
8 to 14 % opacity, used for depth bars, selected rows and badges. Chart-only tokens:
`--chart-grid`, `--chart-axis`, `--chart-crosshair`, `--chart-label`.

**Type.** A system font stack (Inter is used if installed locally; nothing is downloaded).
Scale 11 / 12 / 13 / 15 / 20 px (`--fs-xs` to `--fs-xl`); body 13 px. Tabular numerals
everywhere (`font-variant-numeric: tabular-nums`). Weights 400 / 500 / 600, 650 for the pair
and primary button.

**Spacing.** 4 px base: 4, 8, 12, 16, 24 (`--s1` to `--s5`); 6 px gap between panels.
Radii 4 (small controls), 6 (inputs, buttons), 8 (panels). Panel headers are all 40 px.
Depth comes from surface steps and 1 px borders; the only shadow is on floating layers
(markets drawer, toast). Transitions are 120 ms; animations are switched off under
`prefers-reduced-motion`.

## What changed, per component

- **Header** (`App.tsx`): new logo mark (an outlined diamond with a solid core, inline SVG) and
  "Radix DEX" wordmark; the pair reads first (base symbol large, quote muted, chevron), then
  the price at 20 px with the chart change as a tinted chip; Liquidity, 24 h volume and Venues
  as a quieter definition list after a divider; network shown as a pill with a status dot.
  Stats drop away progressively as the width shrinks; on phones they move to their own row.
- **Favicon**: the same mark as an inline SVG data URI in `index.html`, so it works under any
  `VITE_BASE`. `theme-color` meta added.
- **Mainnet banner**: warm tint, amber left rule and warning icon; the first sentence is bold.
  Text unchanged.
- **Panels and tabs**: one header style everywhere; tabs share one underline style (accent,
  2 px, sitting on the header rule). Counts in "Open orders" and "Trades" are small badges.
  The chart's pair title moved out of the tablist. `role="tablist"`/`role="tab"`/`aria-selected`
  added where missing (order type, your orders); segmented controls (intervals, slippage, fills,
  buy/sell) carry `aria-pressed`.
- **Markets list**: search field with icon and focus ring, column header row, 30 px rows,
  base symbol bold and quote muted, selected row tinted with an accent bar and `aria-current`,
  zero volumes dimmed, empty search state.
- **Markets drawer** (under 1100 px): now a floating panel at the left with a shadow and a
  dimmed backdrop; clicking the backdrop closes it (the one small interaction added).
- **Charts** (`Chart.tsx`, `DepthChart.tsx`): colours from the palette, subtler grid, rounded
  price tags, a faint dashed line at the last price, crosshair tags on both axes (time tag is
  new), OHLC legend with muted letters and coloured values, volume drawn behind the candles.
  Depth hover label is a rounded tag with a buy/sell colour mark. Behaviour (zoom, drag,
  click-to-pick price) unchanged. While a new interval loads over an old chart, a thin
  progress bar shows instead of covering the chart.
- **Order book / trades** (`Book.tsx`): 21 px rows, softer depth bars, mid price row on the page
  background, spread value emphasised; skeleton rows instead of "loading…" and "Loading…".
- **Order form** (`OrderForm.tsx`): buy/sell as a segmented control with solid green/red;
  Market/Limit tabs with the available balance beside them; 40 px inputs with label, value and
  unit, focus ring; percentage chips; summary below a dashed rule; a solid 42 px primary button.
  When the button is blocked (for example "Connect your Radix Wallet") it now looks neutral
  rather than a faded green, so it no longer reads as a buy button. Notes carry an info icon.
- **Your orders** (`Orders.tsx`): 32 px rows with hairline separators, sticky header, Cancel as
  a small outline button that turns red on hover, "View" link with an external-link icon,
  icon-led empty states.
- **Loading and errors**: first load shows a pulsing logo mark; the fatal screen has a title and
  a primary "Try again" button; toast has an icon and accent rule.
- **Responsive**: three columns above 1100 px (264 / flexible / 340, narrowing to 240 / 320 at
  1440 px). The right column now keeps the order book at least 264 px tall and scrolls if the
  window is short, so the book no longer shrinks to three rows a side at 1280 x 820. Under
  760 px the page is one column ordered chart, order form, order book, your orders (the form
  used to come after your orders); the chart is 360 px tall.
- New files: `theme.ts` (chart colours from CSS) and `ui.tsx` (logo, icons, empty state,
  skeleton rows).

## Left alone on purpose

- **Light theme**: skipped. The tokens make it a contained job later (a second `:root` block and
  a `color-scheme` switch), but the Radix connect button has its own theme and I did not want
  to ship it half done.
- **Radix connect button**: only its height and corner radius are set. Its colours are set
  inside its shadow DOM by its theme, and outer custom properties did not override them; changing
  the theme would mean calling `buttonApi.setTheme` in `wallet.ts`, which is outside this brief.
- No web font, no new dependencies, no change to any wording that explains fees, fills or risk.

## Bugs and oddities noticed (not fixed)

1. The header price is the order book mid (`depth.mid`), while the chart's last-price tag is the
   last candle close; on XRD/hUSDC they differ (0.00091862 against 0.00087115), which can look
   like a mistake. Pre-existing.
2. The chart's last-price tag can sit on top of a price-axis label (visible in the screenshots).
   Pre-existing; would need the axis labels to skip the tag's band.
3. Above 1100 px the pair button still toggles `showMarkets` although there is no drawer; if the
   window is then narrowed the drawer appears open. Pre-existing.
4. The "Change (chart)" figure is the change across whatever candles are loaded, so it varies
   with the interval selected (230 % at 1 h on XRD/hUSDC). It is labelled, but traders will read
   it as a 24 h change.
