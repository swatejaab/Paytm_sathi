import { Icon } from './Icon';

export type ViewMode = 'app' | 'web';

export function readViewMode(): ViewMode {
  try {
    const saved = localStorage.getItem('saathi.view');
    if (saved === 'app' || saved === 'web') return saved;
  } catch {
    // fall through to the screen-size default
  }
  return window.innerWidth < 760 ? 'app' : 'web';
}

export function saveViewMode(mode: ViewMode): void {
  try {
    localStorage.setItem('saathi.view', mode);
  } catch {
    // convenience only
  }
}

export function ViewToggle({ mode, onChange, className = '' }: { mode: ViewMode; onChange: (mode: ViewMode) => void; className?: string }) {
  return (
    <div className={`view-toggle ${className}`} role="radiogroup" aria-label="Layout">
      <button role="radio" aria-checked={mode === 'app'} className={mode === 'app' ? 'active' : ''} onClick={() => onChange('app')}>
        <Icon name="phone" size={16} /> App
      </button>
      <button role="radio" aria-checked={mode === 'web'} className={mode === 'web' ? 'active' : ''} onClick={() => onChange('web')}>
        <Icon name="monitor" size={16} /> Web
      </button>
    </div>
  );
}
