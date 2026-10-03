import { useRef, useState } from 'react';
import { useTheme } from '../theme';
import type { ViewMode } from '../viewMode';
import { ThemeToggle } from './AppHeader';
import { BrandMark } from './Icon';
import { ViewToggle } from './ViewToggle';

// App view on larger screens: the same app, rendered at phone width inside a device frame.
export function PhonePreview({ onViewMode }: { onViewMode: (mode: ViewMode) => void }) {
  const [theme, , toggleTheme] = useTheme();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [src] = useState(() => `${window.location.pathname}?view=frame${window.location.hash}`);

  // Mirror the framed app's route in the address bar, so switching to Web or reloading keeps the same screen.
  const onLoad = () => {
    const framed = frameRef.current?.contentWindow;
    if (!framed) return;
    const sync = () => window.history.replaceState(null, '', `${window.location.pathname}${framed.location.hash}`);
    sync();
    framed.addEventListener('hashchange', sync);
    framed.addEventListener('popstate', sync);
  };

  return (
    <div className="phone-stage">
      <div className="app-bg" aria-hidden />
      <header className="phone-toolbar">
        <span className="brand">
          <BrandMark size={34} />
          <span className="brand-text">
            <strong>
              Paytm <span>Saathi</span>
            </strong>
          </span>
        </span>
        <div className="header-actions">
          <ViewToggle mode="app" onChange={onViewMode} />
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </header>
      <main className="phone-wrap">
        <div className="phone-frame">
          <iframe ref={frameRef} src={src} title="Paytm Saathi app" onLoad={onLoad} />
        </div>
      </main>
    </div>
  );
}
