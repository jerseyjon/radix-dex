import type { ReactNode } from 'react';
import logo from './assets/difd-64.png';

/** The DIFD site the DEX belongs to: the logo links back to it. */
export const DIFD_URL = 'https://difd.net';

export type Section = 'trade' | 'pools';

/**
 * The floating glass pill of difd.net: the DIFD logo (back to difd.net), the DEX's sections and, in
 * `end`, the network, the account picker and the wallet button. On phones the sections move to a
 * glass tab bar at the bottom (SiteTabBar), as on difd.net, and the pill keeps the logo and the wallet.
 */
export function SiteNav({ current, showPools, end }: { current: Section; showPools: boolean; end?: ReactNode }) {
  return (
    <nav className="pillbar glass" aria-label="Main">
      <a className="brand-link" href={DIFD_URL} aria-label="DIFD home (difd.net)">
        <img src={logo} alt="" width="34" height="34" />
        <span className="brand-name">DIFD</span>
      </a>
      <div className="nav">
        <a className="nav-link" href="#" aria-current={current === 'trade' ? 'page' : undefined}>Trade</a>
        {showPools && <a className="nav-link" href="#/pools" aria-current={current === 'pools' ? 'page' : undefined}>Pools</a>}
      </div>
      {end && <div className="pill-end">{end}</div>}
    </nav>
  );
}

const TAB_ICONS = {
  trade: 'M4 17l5-5 4 4 7-8M20 8v5M20 8h-5',
  pools: 'M5 9c2.5-2 4.5-2 7 0s4.5 2 7 0M5 15c2.5-2 4.5-2 7 0s4.5 2 7 0',
  home: 'M4 11 12 4l8 7v9h-5v-6H9v6H4z',
} as const;

function TabIcon({ name }: { name: keyof typeof TAB_ICONS }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={TAB_ICONS[name]} />
    </svg>
  );
}

/** Phones: the glass tab bar at the bottom of the screen (difd.net's pattern). Hidden on wider screens by CSS. */
export function SiteTabBar({ current, showPools }: { current: Section; showPools: boolean }) {
  return (
    <nav className="tabbar glass" aria-label="Sections">
      <a className="tab" href="#" aria-current={current === 'trade' ? 'page' : undefined}><TabIcon name="trade" />Trade</a>
      {showPools && <a className="tab" href="#/pools" aria-current={current === 'pools' ? 'page' : undefined}><TabIcon name="pools" />Pools</a>}
      <a className="tab" href={DIFD_URL}><TabIcon name="home" />DIFD</a>
    </nav>
  );
}

/** The light fields behind the glass (subtle here: trading data must stay readable). Decorative only. */
export function Fields() {
  return (
    <div className="fields" aria-hidden="true">
      <div className="lf lf-1" /><div className="lf lf-2" /><div className="lf lf-3" /><div className="lf lf-4" />
    </div>
  );
}
