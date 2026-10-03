import { useCallback, useEffect, useState } from 'react';

export type ViewMode = 'app' | 'web';

const VIEW_KEY = 'saathi.view';
const DEFAULT_VIEWPORT = 'width=device-width, initial-scale=1.0, viewport-fit=cover';
const DESKTOP_VIEWPORT = 'width=1280, viewport-fit=cover';

// The app running inside the phone frame of the App view. It never shows the view switch itself.
export const isFramed = window.self !== window.top && new URLSearchParams(window.location.search).get('view') === 'frame';

// Phones and small tablets already get the app layout natively; on them "Web" asks for the desktop layout instead.
export const isSmallDevice = Math.min(window.screen.width, window.screen.height) < 768;

function readViewMode(): ViewMode {
  try {
    const saved = localStorage.getItem(VIEW_KEY);
    if (saved === 'app' || saved === 'web') return saved;
  } catch {
    // storage blocked: fall back to the device default
  }
  return isSmallDevice ? 'app' : 'web';
}

function applyViewport(mode: ViewMode): void {
  if (!isSmallDevice || isFramed) return;
  document.querySelector('meta[name="viewport"]')?.setAttribute('content', mode === 'web' ? DESKTOP_VIEWPORT : DEFAULT_VIEWPORT);
}

export function useViewMode(): [ViewMode, (mode: ViewMode) => void] {
  const [mode, setModeState] = useState<ViewMode>(readViewMode);
  useEffect(() => applyViewport(mode), [mode]);
  const setMode = useCallback((next: ViewMode) => {
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // the choice still applies for this visit
    }
    setModeState(next);
  }, []);
  return [mode, setMode];
}
