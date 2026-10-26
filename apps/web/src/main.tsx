import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { TestSignInPage } from './TestSignInPage';
import './styles.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('Missing #root element in index.html');
}

// Minimal path switch until the app shell and router arrive (TRP-T34).
const page = window.location.pathname === '/sign-in/test' ? <TestSignInPage /> : <App />;

createRoot(root).render(<StrictMode>{page}</StrictMode>);
