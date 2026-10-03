// Deterministic language understanding for Saathi conversations: intent, amounts and what each amount
// refers to, yes/no answers, dates, and purchase items. Works for English, Hinglish, and common Hindi terms.
// Every amount it returns was written by the customer; nothing is inferred or invented.
import { settings } from '../config';
import { classifyWithPlaybooks } from '../playbooks/registry';
import type { JourneyId } from '../types';

export type AmountRole = 'bill' | 'insurance' | 'self_pay' | 'emi' | 'salary' | 'debit' | 'price' | 'target' | 'saved' | 'monthly';

export interface AmountMention {
  value: number;
  index: number;
  raw: string;
  role: AmountRole | null;
}

export interface DateMention {
  date: string;
  raw: string;
  role: 'emi' | 'salary' | null;
}

export interface Understanding {
  text: string;
  journey: JourneyId | null;
  amounts: AmountMention[];
  dates: DateMention[];
  yes: boolean;
  no: boolean;
  dontKnow: boolean;
  hasInsurance: boolean | null;
  medical: boolean;
  otherBill: boolean;
  greeting: boolean;
  thanks: boolean;
  help: boolean;
  handoff: boolean;
  askWhy: boolean;
  askNext: boolean;
  useAccountAmount: boolean;
  planWithoutInsurance: boolean;
  item: string | null;
  targetDate: string | null;
  language: 'en' | 'hinglish';
}

const DEVANAGARI_DIGITS = '०१२३४५६७८९';

export function normalizeText(text: string): string {
  return text
    .replace(/[०-९]/g, (digit) => String(DEVANAGARI_DIGITS.indexOf(digit)))
    .replace(/[’`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

const UNIT_MULTIPLIERS: [RegExp, number][] = [
  [/^(crores?|cr|करोड़?)$/i, 1e7],
  [/^(lakhs?|lacs?|l|लाख)$/i, 1e5],
  [/^(k|thousand|hazaa?r|हज़ार|हजार)$/i, 1e3],
];

const AMOUNT_RE =
  /(₹|\brs\.?|\binr\b|\brupees?\b)?\s*(\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(crores?|cr\b|lakhs?\b|lacs?\b|l\b|k\b|thousand\b|hazaa?r\b|हज़ार|हजार|लाख|करोड़?)?\s*(rupees?\b|rs\b|₹|रुपये|रुपए)?/giu;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_WORD = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;

export function parseAmounts(input: string): AmountMention[] {
  const text = normalizeText(input);
  const mentions: AmountMention[] = [];
  for (const match of text.matchAll(AMOUNT_RE)) {
    const [raw, currency, digits, unit, suffixCurrency] = match;
    const index = match.index ?? 0;
    const start = index + raw.indexOf(digits!);
    const before = text.slice(Math.max(0, start - 12), start).toLowerCase();
    const after = text.slice(start + digits!.length, start + digits!.length + 14).toLowerCase();
    const hasMarker = Boolean(currency || unit || suffixCurrency);
    const base = Number(digits!.replace(/,/g, ''));
    if (!Number.isFinite(base) || base <= 0) continue;
    if (/^\s*(%|percent|per cent)/.test(after)) continue;
    if (!unit && /^\s*(st|nd|rd|th)\b/.test(after)) continue;
    if (!unit && /^\s*(days?|months?|years?|yrs?|din|mahine|saal|weeks?|hours?|hrs?|mins?|am|pm|:\d|times?|emis?|installments?)\b/.test(after)) continue;
    if (!hasMarker && /^\s*\d{2}:\d{2}/.test(after)) continue;
    if (!hasMarker && /^[0-9]{4}$/.test(digits!) && base >= 1900 && base <= 2100) continue;
    if (!hasMarker && (MONTH_WORD.test(before.slice(-10)) || MONTH_WORD.test(after.slice(0, 10)))) continue;
    if (!hasMarker && digits!.replace(/,/g, '').length >= 10) continue;
    let multiplier = 1;
    if (unit) {
      const found = UNIT_MULTIPLIERS.find(([pattern]) => pattern.test(unit.trim()));
      multiplier = found ? found[1] : 1;
    }
    const value = Math.round(base * multiplier);
    if (!hasMarker && value < 100) continue;
    if (value > 1e9) continue;
    mentions.push({ value, index: start, raw: raw.trim(), role: null });
  }
  return mentions;
}

const ROLE_KEYWORDS: [AmountRole, RegExp][] = [
  ['insurance', /\b(insurance|insured|insurer|cover|covers|covered|coverage|policy|claim|tpa|cashless|mediclaim)\b|बीमा|इंश्योरेंस/gi],
  ['self_pay', /\b(can pay|could pay|will pay|i'?ll pay|pay myself|myself|i have|i've got|i got|have saved|my savings|savings|my own|own pocket|arrange|manage|contribute|de sakt[aei]|de sakunga|de dunga|mere paas|mere pass|in hand|in my account|i can afford|afford to pay)\b|दे सकत|मेरे पास/gi],
  ['emi', /\b(emi|emis|installment|instalment|kist|kisht)\b|किस्त|ईएमआई/gi],
  ['salary', /\b(salary|income|earn|earning|earnings|tankhwah|pagar)\b|सैलरी|वेतन/gi],
  ['monthly', /\b(per month|a month|monthly|every month|har mahine|each month)\b/gi],
  ['saved', /\b(saved|already have|so far|already saved)\b/gi],
  ['target', /\b(goal|target|save up|saving for|save for|need to save)\b/gi],
  ['debit', /\b(upi|debited|deducted|debit|transaction|txn|kat gaye|kat gaya|kata|charged|payment|paid)\b/gi],
  ['price', /\b(buy|buying|purchase|price|priced|worth|costs?|afford|kharid\w*|lena)\b/gi],
  ['bill', /\b(bill|bills|total|charges|estimate|estimated|kharcha|kharch|hospital)\b|बिल|खर्च/gi],
];

const CLAUSE_BREAK = /[.;!?\n](?=\s|$)|,\s|\s(?:but|and|lekin|par|aur|while|whereas|so|toh|to)\s/gi;

function clauseAround(text: string, index: number): { start: number; end: number } {
  let start = 0;
  let end = text.length;
  for (const match of text.matchAll(CLAUSE_BREAK)) {
    const position = match.index ?? 0;
    if (position + match[0].length <= index) start = position + match[0].length;
    else if (position >= index) {
      end = position;
      break;
    }
  }
  return { start, end };
}

// Tags each amount with the role named closest to it in the same clause ("bill is 5 lakh, insurance covers 3 lakh").
export function assignRoles(input: string, amounts: AmountMention[]): AmountMention[] {
  const text = normalizeText(input).toLowerCase();
  return amounts.map((amount) => {
    const { start, end } = clauseAround(text, amount.index);
    const clause = text.slice(start, end);
    const amountStart = amount.index - start;
    const amountEnd = amountStart + amount.raw.length;
    let best: { role: AmountRole; distance: number } | null = null;
    for (const [role, pattern] of ROLE_KEYWORDS) {
      for (const match of clause.matchAll(pattern)) {
        const position = match.index ?? 0;
        if (position >= amountStart && position < amountEnd) continue;
        const distance = position < amountStart ? amountStart - (position + match[0].length) : position - amountEnd;
        if (!best || distance < best.distance) best = { role, distance };
      }
    }
    return { ...amount, role: best?.role ?? null };
  });
}

const WEEKDAYS: [RegExp, number][] = [
  [/\b(sunday|sun|ravivar|itwar)\b|रविवार/i, 0],
  [/\b(monday|mon|somvar|somwar)\b|सोमवार/i, 1],
  [/\b(tuesday|tue|tues|mangalvar|mangalwar)\b|मंगलवार/i, 2],
  [/\b(wednesday|wed|budhvar|budhwar)\b|बुधवार/i, 3],
  [/\b(thursday|thu|thur|thurs|guruvar|guruwar|brihaspativar)\b|गुरुवार/i, 4],
  [/\b(friday|fri|shukravar|shukrawar)\b|शुक्रवार/i, 5],
  [/\b(saturday|sat|shanivar|shaniwar)\b|शनिवार/i, 6],
];

const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const addDaysIso = (date: string, days: number) => isoDay(new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000));

export function nextWeekday(from: string, weekday: number): string {
  const current = new Date(`${from}T00:00:00Z`).getUTCDay();
  return addDaysIso(from, (weekday - current + 7) % 7);
}

export function parseDates(input: string): DateMention[] {
  const text = normalizeText(input).toLowerCase();
  const today = settings.demoDate;
  const found: { date: string; raw: string; index: number }[] = [];
  for (const [pattern, weekday] of WEEKDAYS) {
    const match = pattern.exec(text);
    if (match) found.push({ date: nextWeekday(today, weekday), raw: match[0], index: match.index });
  }
  const relative: [RegExp, number][] = [
    [/\b(today|aaj)\b|आज/i, 0],
    [/\b(tomorrow|kal)\b|कल/i, 1],
    [/\b(day after tomorrow|parso)\b|परसों/i, 2],
  ];
  for (const [pattern, offset] of relative) {
    const match = pattern.exec(text);
    if (match) found.push({ date: addDaysIso(today, offset), raw: match[0], index: match.index });
  }
  const explicit = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i.exec(text);
  if (explicit) {
    const year = Number(today.slice(0, 4));
    const month = MONTHS.indexOf(explicit[2]!.toLowerCase());
    let date = isoDay(new Date(Date.UTC(year, month, Number(explicit[1]))));
    if (date < today) date = isoDay(new Date(Date.UTC(year + 1, month, Number(explicit[1]))));
    found.push({ date, raw: explicit[0], index: explicit.index });
  }
  return found
    .sort((a, b) => a.index - b.index)
    .map((mention) => {
      const { start, end } = clauseAround(text, mention.index);
      const clause = text.slice(start, end);
      const role = /\b(salary|income|tankhwah|pagar|paise aayenge|credit)\b|सैलरी|वेतन/.test(clause)
        ? 'salary'
        : /\b(emi|installment|instalment|kist|due)\b|किस्त|ईएमआई/.test(clause)
          ? 'emi'
          : null;
      return { date: mention.date, raw: mention.raw, role };
    });
}

// "by December 2028", "in 3 years", "by 2030" -> last day of that month or year.
export function parseTargetDate(input: string): string | null {
  const text = normalizeText(input).toLowerCase();
  const today = settings.demoDate;
  const monthYear = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(20\d{2})\b/.exec(text);
  if (monthYear) {
    const month = MONTHS.indexOf(monthYear[1]!);
    return isoDay(new Date(Date.UTC(Number(monthYear[2]), month + 1, 0)));
  }
  const yearOnly = /\b(?:by|in|till|until|before)\s+(20\d{2})\b/.exec(text);
  if (yearOnly) return `${yearOnly[1]}-12-31`;
  const span = /\b(?:in|within|over)\s+(\d{1,2})\s+(years?|months?|saal|mahine)\b/.exec(text);
  if (span) {
    const amount = Number(span[1]);
    const months = /year|saal/.test(span[2]!) ? amount * 12 : amount;
    const date = new Date(`${today}T00:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() + months);
    return isoDay(date);
  }
  return null;
}

const HINGLISH_MARKERS = new Set([
  'hai', 'hain', 'kya', 'karun', 'karu', 'mein', 'mera', 'mere', 'meri', 'nahi', 'nahin', 'kiya', 'maine', 'paisa', 'paise',
  'aur', 'ab', 'kaise', 'kab', 'hua', 'gaya', 'chahiye', 'madad', 'bhai', 'papa', 'mummy', 'ko', 'ki', 'ka', 'lekin', 'aayegi',
  'hoga', 'kar', 'sakta', 'sakti', 'mujhe', 'humein', 'kitna', 'kitne',
]);

export function detectLanguageOf(text: string): 'en' | 'hinglish' {
  if (/[\u0900-\u097F]/.test(text)) return 'hinglish';
  const words = normalizeText(text).toLowerCase().match(/[a-z]+/g) ?? [];
  return words.filter((word) => HINGLISH_MARKERS.has(word)).length >= 2 ? 'hinglish' : 'en';
}

const has = (text: string, pattern: RegExp) => pattern.test(text);

const ITEM_WORDS =
  /\b(iphone(?:\s*\d+(?:\s*pro(?:\s*max)?)?)?|phone|smartphone|mobile|laptop|macbook|tv|television|fridge|refrigerator|washing machine|ac|air conditioner|car|bike|scooter|scooty|motorcycle|house|home|flat|apartment|watch|camera|sofa|furniture|gold|jewellery|jewelry|trip|vacation|holiday|wedding|course|tablet|ipad|console|playstation|xbox)\b/i;

function purchaseItem(text: string): string | null {
  const match = ITEM_WORDS.exec(text);
  if (!match) return null;
  const word = match[0].trim();
  if (/^iphone/i.test(word)) return word.replace(/^iphone/i, 'iPhone');
  if (/^(tv|ac)$/i.test(word)) return word.toUpperCase();
  return word.toLowerCase();
}

function detectJourney(text: string, lower: string): JourneyId | null {
  if (has(lower, /\b(talk|speak|connect|chat)\s+(to|with)\s+(a\s+|an\s+|some\s*one|someone)?\s*(human|person|agent|specialist|expert|executive|advisor|adviser|real person)|\bcustomer care\b|\bcall me\b|\bspecialist se baat\b|\bkisi se baat\b/)) {
    return 'specialist';
  }
  const classified = classifyWithPlaybooks(text);
  const byPlaybook: Partial<Record<string, JourneyId>> = {
    hospitalization: 'hospital',
    upi_dispute: 'upi_fraud',
    failed_refund: 'failed_refund',
    emi_shortfall: 'emi',
    protection: 'protection',
  };
  const playbookJourney = byPlaybook[classified.event_type] ?? null;
  // A purchase question ("can I afford an iPhone?") is planning, even when it mentions EMI or a loan.
  const afford = has(lower, /\b(can|could|should)\s+i\s+(afford|buy|purchase|get|take)\b|\bafford\b|\bkharid\s*(sakta|sakti|sakte|lu|loon|lun)\b|\ble\s+(sakta|sakti|sakte)\b|\bworth buying\b/);
  const goal = has(lower, /\b(save|saving|savings)\s+(for|up|towards)\b|\b(financial\s+)?goal\b|\bplan(ning)?\s+(to\s+buy|for\s+(a|my|the))\b|\bwant to buy\b.*\b(by|in)\s+(20\d{2}|\d+\s+years?)/);
  if (afford && playbookJourney !== 'hospital' && playbookJourney !== 'upi_fraud' && playbookJourney !== 'protection') return 'afford';
  if (playbookJourney) return playbookJourney;
  if (goal) return 'goal';
  if (has(lower, /\b(medical|treatment|operation|doctor|nursing home|clinic|admit|admission)\b/)) return 'hospital';
  if (has(lower, /\bbill\b|बिल/)) return 'bill';
  return null;
}

export function understand(input: string): Understanding {
  const text = normalizeText(input);
  const lower = text.toLowerCase();
  const amounts = assignRoles(text, parseAmounts(text));
  const negativeInsurance = has(
    lower,
    /\b(no|not|don'?t|do not|doesn'?t|without|never)\b[^.!?]{0,25}\b(insurance|insured|policy|mediclaim|cover)\b|\b(insurance|policy|mediclaim)\b[^.!?]{0,12}\b(nahi|nahin|nhi|nai)\b|बीमा नहीं/,
  );
  const positiveInsurance =
    !negativeInsurance &&
    (has(lower, /\b(have|got|has|with)\s+(a\s+|an\s+)?(health\s+|medical\s+|family\s+)?(insurance|policy|mediclaim|cover)\b|\b(insurance|policy|mediclaim)\s+(hai|he|h|hain)\b|\binsured\b|\bcashless\b|\bclaim\b|\btpa\b/) ||
      amounts.some((amount) => amount.role === 'insurance'));
  const yes = has(lower, /^(yes|yeah|yep|yup|haan|han|ha|ji|ji haan|sure|ok|okay|okk|allow|allowed|go ahead|please do|correct|right|theek hai|thik hai|bilkul|of course)\b/) ||
    has(lower, /\b(allow access|yes,? (i|please|allow|go))\b/);
  const no = !yes && has(lower, /^(no|nope|nah|nahi|nahin|na|not now|don'?t|do not|never|skip|later)\b/);
  const dontKnow = has(lower, /\b(don'?t know|do not know|not sure|no idea|unsure|pata nahi|nahi pata|maloom nahi|malum nahi|idk|can'?t say)\b|पता नहीं/);
  const journey = detectJourney(text, lower);
  return {
    text,
    journey,
    amounts,
    dates: parseDates(text),
    yes,
    no,
    dontKnow,
    hasInsurance: negativeInsurance ? false : positiveInsurance ? true : null,
    medical: has(lower, /\b(hospital|medical|treatment|surgery|operation|doctor|icu|admitted|insurance|mediclaim|clinic|nursing home|health)\b|अस्पताल|हॉस्पिटल/),
    otherBill: has(lower, /\b(electricity|power|phone|mobile|internet|broadband|credit card|card bill|water|gas|rent|school|fee|fees|another bill|other bill|not (a )?(hospital|medical))\b/),
    greeting: has(lower, /^(hi|hii+|hello|hey|hola|namaste|namaskar|good (morning|afternoon|evening)|yo)\b/) && lower.length <= 40,
    thanks: has(lower, /\b(thanks|thank you|thx|dhanyavad|dhanyawad|shukriya)\b/),
    help: has(lower, /\b(what can you do|how can you help|help me|what do you do|madad|kya kar sakte)\b|^help\b/),
    handoff: journey === 'specialist',
    askWhy: has(lower, /\b(why|kyun|kyon|explain|reason)\b/),
    askNext: has(lower, /\b(what next|next step|what now|what should i do|ab kya|kya karun|kya karna)\b/),
    useAccountAmount: has(lower, /\b(safe amount|use my account|from my account|account'?s safe|use the safe)\b/),
    planWithoutInsurance: has(lower, /\b(plan without insurance|without insurance for now|assume no insurance|no insurance payout|worst case)\b/),
    item: purchaseItem(text),
    targetDate: parseTargetDate(text),
    language: detectLanguageOf(text),
  };
}
