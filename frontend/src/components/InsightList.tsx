import type { ProactiveInsight } from '../types';
import { Icon, type IconName } from './Icon';

const TONE_ICON: Record<ProactiveInsight['tone'], IconName> = {
  good: 'check',
  info: 'info',
  warn: 'alert',
  alert: 'alert',
};

export function InsightList({ items, onAsk }: { items: ProactiveInsight[]; onAsk: (text: string) => void }) {
  if (!items.length) return <p className="muted small">Nothing needs your attention right now.</p>;
  return (
    <ul className="insight-list">
      {items.map((item) => (
        <li key={item.id} className={`insight insight-${item.tone}`}>
          <span className="insight-icon">
            <Icon name={TONE_ICON[item.tone]} size={18} />
          </span>
          <div>
            <strong>{item.title}</strong>
            <p>{item.detail}</p>
            {item.ask && (
              <button className="link" onClick={() => onAsk(item.ask!)}>
                Ask Saathi
              </button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
