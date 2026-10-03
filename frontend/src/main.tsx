import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { PhonePreview } from './components/PhonePreview';
import { isFramed, isSmallDevice, useViewMode } from './viewMode';
import './styles.css';

function Root() {
  const [viewMode, setViewMode] = useViewMode();
  if (isFramed) return <App />;
  if (viewMode === 'app' && !isSmallDevice) return <PhonePreview onViewMode={setViewMode} />;
  return <App viewMode={viewMode} onViewMode={setViewMode} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
