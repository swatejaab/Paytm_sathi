// Minimal stroke icon set for the app view (24x24, currentColor).
const PATHS = {
  home: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10',
  chat: 'M4 5h16v11H9l-5 4z M8 10h8 M8 13h5',
  insights: 'M4 4v16h16 M8 15l3-4 3 2 5-6',
  activity: 'M9 6h11 M9 12h11 M9 18h11 M4.5 6h.01 M4.5 12h.01 M4.5 18h.01',
  user: 'M12 12a4 4 0 100-8 4 4 0 000 8z M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6',
  bell: 'M6 9a6 6 0 1112 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9z M10 20a2 2 0 004 0',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 15a3 3 0 100-6 3 3 0 000 6z',
  eyeOff: 'M3 3l18 18 M10.6 5.1A10 10 0 0112 5c6 0 10 7 10 7a17 17 0 01-3.2 3.9 M6.6 6.6C3.9 8.4 2 12 2 12s4 7 10 7a9.7 9.7 0 004.4-1',
  hospital: 'M4 21V8l8-5 8 5v13z M12 9v7 M8.5 12.5h7',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z M9 12l2 2 4-4',
  refund: 'M3 12a9 9 0 109-9 9.7 9.7 0 00-6.7 2.8L3 8 M3 3v5h5',
  calendar: 'M4 6h16v14H4z M4 10h16 M8 3v4 M16 3v4',
  scale: 'M12 4v16 M7 20h10 M5 8h14 M5 8l-3 6a3 3 0 006 0z M19 8l-3 6a3 3 0 006 0z',
  trend: 'M3 17l6-6 4 4 8-8 M15 7h6v6',
  folder: 'M3 6h6l2 2h10v11H3z',
  headset: 'M4 15v-3a8 8 0 1116 0v3 M4 15h3v5H4z M17 15h3v5h-3z',
  mic: 'M12 15a3 3 0 003-3V6a3 3 0 10-6 0v6a3 3 0 003 3z M5 11a7 7 0 0014 0 M12 18v3',
  send: 'M4 12l16-8-6 16-3-7z',
  back: 'M15 18l-6-6 6-6',
  next: 'M9 18l6-6-6-6',
  sparkle: 'M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z',
  phone: 'M8 3h8v18H8z M11 18h2',
  monitor: 'M3 5h18v11H3z M8 21h8 M12 16v5',
  globe: 'M12 21a9 9 0 100-18 9 9 0 000 18z M3 12h18 M12 3c3 3 3 15 0 18 M12 3c-3 3-3 15 0 18',
  logout: 'M15 4h4v16h-4 M10 8l-4 4 4 4 M6 12h11',
  lock: 'M6 11h12v10H6z M8 11V8a4 4 0 118 0v3',
  alert: 'M12 3l10 18H2z M12 10v4 M12 17.5h.01',
  plus: 'M12 5v14 M5 12h14',
  close: 'M6 6l12 12 M18 6L6 18',
  wallet: 'M3 7h18v13H3z M3 7l3-3h11l2 3 M16 13.5h2',
  backspace: 'M9 5h12v14H9l-6-7z M13 10l4 4 M17 10l-4 4',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 22, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
