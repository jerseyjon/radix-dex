import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { PoolsPage } from './PoolsPage';
import './styles.css';

declare global {
  namespace JSX { interface IntrinsicElements { 'radix-connect-button': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> } }
}

/** #/pools and #/pools/<component> show the owner's pools; any other hash is the trading page's market. */
function Root() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const f = () => setHash(location.hash);
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  return hash.startsWith('#/pools') ? <PoolsPage route={hash} /> : <App />;
}

createRoot(document.getElementById('root')!).render(<StrictMode><Root /></StrictMode>);
