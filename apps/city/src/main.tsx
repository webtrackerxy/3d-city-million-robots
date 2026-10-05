import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Root } from './Root.tsx';
import './styles.css';

const root = document.getElementById('root');
if (root === null) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
