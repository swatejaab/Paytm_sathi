import type { ViewMode } from '../viewMode';
import { Icon } from './Icon';

export function ViewToggle({ mode, onChange }: { mode: ViewMode; onChange: (mode: ViewMode) => void }) {
  return (
    <div className="view-toggle" role="radiogroup" aria-label="Layout">
      <button role="radio" aria-checked={mode === 'app'} className={mode === 'app' ? 'active' : ''} onClick={() => onChange('app')} title="App view">
        <Icon name="phone" size={16} />
        <span>App</span>
      </button>
      <button role="radio" aria-checked={mode === 'web'} className={mode === 'web' ? 'active' : ''} onClick={() => onChange('web')} title="Web view">
        <Icon name="monitor" size={16} />
        <span>Web</span>
      </button>
    </div>
  );
}
