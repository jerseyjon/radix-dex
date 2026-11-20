import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

declare global {
  namespace JSX { interface IntrinsicElements { 'radix-connect-button': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> } }
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
