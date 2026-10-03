// Decorative fintech illustration (phone, rupee coins, shield, growth bars) for the landing screens.
export function HeroArt({ className = '' }: { className?: string }) {
  return (
    <svg className={`hero-art ${className}`} viewBox="0 0 360 240" aria-hidden>
      <defs>
        <linearGradient id="ha-card" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity=".95" />
          <stop offset="1" stopColor="#dff4ff" stopOpacity=".9" />
        </linearGradient>
        <linearGradient id="ha-coin" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="#ffd86b" />
          <stop offset="1" stopColor="#f5a623" />
        </linearGradient>
      </defs>
      <circle cx="300" cy="40" r="70" fill="#ffffff" opacity=".07" />
      <circle cx="40" cy="210" r="60" fill="#ffffff" opacity=".06" />
      {/* growth bars */}
      <g opacity=".85">
        <rect x="24" y="150" width="16" height="40" rx="4" fill="#7fe3ff" />
        <rect x="46" y="130" width="16" height="60" rx="4" fill="#5dd2ff" />
        <rect x="68" y="104" width="16" height="86" rx="4" fill="#33c3ff" />
        <path d="M22 140 L54 118 L76 92 L96 80" stroke="#ffffff" strokeWidth="3" fill="none" strokeLinecap="round" />
        <path d="M88 76 L98 79 L94 88" stroke="#ffffff" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </g>
      {/* phone */}
      <g transform="translate(132 26)">
        <rect width="96" height="176" rx="18" fill="#0b2a63" />
        <rect x="6" y="10" width="84" height="156" rx="12" fill="url(#ha-card)" />
        <rect x="18" y="26" width="60" height="30" rx="8" fill="#00b9f1" />
        <text x="48" y="46" textAnchor="middle" fontSize="13" fontWeight="800" fill="#ffffff">₹ 23,400</text>
        <rect x="18" y="66" width="26" height="22" rx="6" fill="#e3f4ff" />
        <rect x="52" y="66" width="26" height="22" rx="6" fill="#e3f4ff" />
        <rect x="18" y="96" width="26" height="22" rx="6" fill="#e3f4ff" />
        <rect x="52" y="96" width="26" height="22" rx="6" fill="#e3f4ff" />
        <rect x="18" y="128" width="60" height="8" rx="4" fill="#cde9fb" />
        <rect x="18" y="142" width="40" height="8" rx="4" fill="#cde9fb" />
      </g>
      {/* shield */}
      <g transform="translate(250 112)">
        <path d="M34 0 L66 12 V38 C66 60 52 74 34 80 C16 74 2 60 2 38 V12 Z" fill="#ffffff" opacity=".95" />
        <path d="M20 40 L30 50 L49 30" stroke="#16a36b" strokeWidth="6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </g>
      {/* coins */}
      <g>
        <circle cx="272" cy="70" r="20" fill="url(#ha-coin)" />
        <text x="272" y="77" textAnchor="middle" fontSize="20" fontWeight="800" fill="#8a5a00">₹</text>
        <circle cx="108" cy="190" r="15" fill="url(#ha-coin)" />
        <text x="108" y="196" textAnchor="middle" fontSize="15" fontWeight="800" fill="#8a5a00">₹</text>
      </g>
    </svg>
  );
}
