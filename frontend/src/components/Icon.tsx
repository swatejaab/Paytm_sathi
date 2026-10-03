import { useId } from 'react';

// Stroke icon set (24x24, currentColor).
const PATHS = {
  home: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10',
  chat: 'M4 5h16v11H9l-5 4z M8 10h8 M8 13h5',
  insights: 'M4 4v16h16 M8 15l3-4 3 2 5-6',
  target: 'M12 21a9 9 0 100-18 9 9 0 000 18z M12 16a4 4 0 100-8 4 4 0 000 8z M12 12h.01',
  grid: 'M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z',
  user: 'M12 12a4 4 0 100-8 4 4 0 000 8z M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6',
  bell: 'M6 9a6 6 0 1112 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9z M10 20a2 2 0 004 0',
  hospital: 'M4 21V8l8-5 8 5v13z M12 9v7 M8.5 12.5h7',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z M9 12l2 2 4-4',
  calendar: 'M4 6h16v14H4z M4 10h16 M8 3v4 M16 3v4',
  trend: 'M3 17l6-6 4 4 8-8 M15 7h6v6',
  folder: 'M3 6h6l2 2h10v11H3z',
  gauge: 'M4 17a8 8 0 1116 0 M12 17l4-5 M12 17h.01',
  headset: 'M4 15v-3a8 8 0 1116 0v3 M4 15h3v5H4z M17 15h3v5h-3z',
  mic: 'M12 15a3 3 0 003-3V6a3 3 0 10-6 0v6a3 3 0 003 3z M5 11a7 7 0 0014 0 M12 18v3',
  stop: 'M7 7h10v10H7z',
  send: 'M4 12l16-8-6 16-3-7z',
  back: 'M15 18l-6-6 6-6',
  next: 'M9 18l6-6-6-6',
  sparkle: 'M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z',
  globe: 'M12 21a9 9 0 100-18 9 9 0 000 18z M3 12h18 M12 3c3 3 3 15 0 18 M12 3c-3 3-3 15 0 18',
  phone: 'M8 2h8a2 2 0 012 2v16a2 2 0 01-2 2H8a2 2 0 01-2-2V4a2 2 0 012-2z M11 18h2',
  monitor: 'M3 4h18v12H3z M8 21h8 M12 16v5',
  logout: 'M15 4h4v16h-4 M10 8l-4 4 4 4 M6 12h11',
  lock: 'M6 11h12v10H6z M8 11V8a4 4 0 118 0v3',
  alert: 'M12 3l10 18H2z M12 10v4 M12 17.5h.01',
  plus: 'M12 5v14 M5 12h14',
  close: 'M6 6l12 12 M18 6L6 18',
  wallet: 'M3 7h18v13H3z M3 7l3-3h11l2 3 M16 13.5h2',
  sun: 'M12 16a4 4 0 100-8 4 4 0 000 8z M12 2v2 M12 20v2 M4.9 4.9l1.4 1.4 M17.7 17.7l1.4 1.4 M2 12h2 M20 12h2 M4.9 19.1l1.4-1.4 M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z',
  clip: 'M20 11.5l-8.3 8.3a5 5 0 01-7-7L13 4.5a3.3 3.3 0 014.7 4.7L9.4 17.5a1.7 1.7 0 01-2.4-2.4L14.8 7.3',
  dots: 'M12 5h.01 M12 12h.01 M12 19h.01',
  edit: 'M4 20h4L19 9l-4-4L4 16z M13.5 6.5l4 4',
  trash: 'M4 7h16 M10 11v6 M14 11v6 M6 7l1 13h10l1-13 M9 7V4h6v3',
  menu: 'M4 6h16 M4 12h16 M4 18h16',
  check: 'M5 12l5 5 9-10',
  pause: 'M8 5v14 M16 5v14',
  play: 'M7 5l12 7-12 7z',
  info: 'M12 21a9 9 0 100-18 9 9 0 000 18z M12 11v5 M12 8h.01',
  help: 'M12 21a9 9 0 100-18 9 9 0 000 18z M9.5 9a2.5 2.5 0 015 .5c0 2-2.5 2-2.5 4 M12 17h.01',
  file: 'M6 3h8l4 4v14H6z M14 3v4h4 M9 13h6 M9 17h6',
  link: 'M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1 M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6z M19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-2.7 1.1V21a2 2 0 11-4 0v-.1a1.6 1.6 0 00-2.7-1.1l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00-1.1-2.7H3a2 2 0 110-4h.1a1.6 1.6 0 001.1-2.7l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 002.7-1.1V3a2 2 0 114 0v.1a1.6 1.6 0 002.7 1.1l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 001.1 2.7H21a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1.3z',
  rupee: 'M7 4h10 M7 9h10 M13 4a5 5 0 010 10H7l8 7',
  card: 'M3 6h18v12H3z M3 10h18 M7 15h3',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 15a3 3 0 100-6 3 3 0 000 6z',
  volume: 'M4 9h4l5-4v14l-5-4H4z M16 9a4 4 0 010 6 M18.5 6.5a8 8 0 010 11',
  sos: 'M12 21a9 9 0 100-18 9 9 0 000 18z M12 16a4 4 0 100-8 4 4 0 000 8z M5.6 5.6l3.6 3.6 M14.8 14.8l3.6 3.6 M18.4 5.6l-3.6 3.6 M9.2 14.8l-3.6 3.6',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 20, className }: { name: IconName; size?: number; className?: string }) {
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

// The AI orb on the Saathi tab of the app's bottom navigation. Everywhere else uses BrandMark.
export function AssistantMark({ size = 36 }: { size?: number }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg viewBox="0 0 40 40" width={size} height={size} aria-hidden className="assistant-mark">
      <defs>
        <radialGradient id={`${id}-core`} cx="32%" cy="28%" r="80%">
          <stop offset="0" stopColor="#8cf4ff" />
          <stop offset="0.42" stopColor="#00baf2" />
          <stop offset="1" stopColor="#5b3df5" />
        </radialGradient>
        <linearGradient id={`${id}-ring`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#00baf2" />
          <stop offset="0.5" stopColor="#a78bfa" />
          <stop offset="1" stopColor="#22d3ee" />
        </linearGradient>
      </defs>
      <circle cx="20" cy="20" r="18.6" fill="none" stroke={`url(#${id}-ring)`} strokeWidth="1.6" />
      <circle cx="20" cy="20" r="15.6" fill={`url(#${id}-core)`} />
      <ellipse cx="14.6" cy="11.8" rx="5.6" ry="2.8" fill="#fff" opacity="0.3" />
      <path d="M19 10.5C19.8 15.6 21.4 17.2 26.5 18 21.4 18.8 19.8 20.4 19 25.5 18.2 20.4 16.6 18.8 11.5 18 16.6 17.2 18.2 15.6 19 10.5Z" fill="#fff" />
      <path d="M26.5 22.5C26.8 24.4 27.3 24.9 29.2 25.2 27.3 25.5 26.8 26 26.5 27.9 26.2 26 25.7 25.5 23.8 25.2 25.7 24.9 26.2 24.4 26.5 22.5Z" fill="#fff" opacity="0.92" />
    </svg>
  );
}

export function BrandMark({ size = 36 }: { size?: number }) {
  return (
    <svg viewBox="0 0 40 40" width={size} height={size} aria-hidden className="brand-mark">
      <defs>
        <linearGradient id="saathi-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#00baf2" />
          <stop offset="1" stopColor="#0f4a8a" />
        </linearGradient>
      </defs>
      <rect width="40" height="40" rx="12" fill="url(#saathi-mark)" />
      <path d="M12 25c2 3 5 4 8 4 4 0 7-2 7-5.5S24 18.5 20 17.5s-6.5-1.6-6.5-4.5S16.5 9 20 9c2.6 0 4.7 1 6 3" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
