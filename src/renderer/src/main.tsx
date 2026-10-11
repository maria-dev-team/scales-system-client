import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './common/styles/base.css';
import DesktopApp from './desktop-app';

const root = createRoot(document.getElementById('root')!);

root.render(
  <StrictMode>
    <DesktopApp />
  </StrictMode>,
);
