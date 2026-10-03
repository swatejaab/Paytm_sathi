import { openaiAvailable, sarvamAvailable } from '../config';
import { asciiDigits, translateWithOpenAI, translateWithSarvam } from '../integrations';
import { LANGUAGE_PROMPT_NAMES, LANGUAGES, type LanguageCode } from '../languages';

// Unicode blocks of the scheduled Indian scripts Saathi reads. Devanagari covers Hindi and Marathi.
const SCRIPTS: [RegExp, LanguageCode][] = [
  [/[\u0900-\u097F]/g, 'hi-IN'],
  [/[\u0980-\u09FF]/g, 'bn-IN'],
  [/[\u0A00-\u0A7F]/g, 'pa-IN'],
  [/[\u0A80-\u0AFF]/g, 'gu-IN'],
  [/[\u0B00-\u0B7F]/g, 'od-IN'],
  [/[\u0B80-\u0BFF]/g, 'ta-IN'],
  [/[\u0C00-\u0C7F]/g, 'te-IN'],
  [/[\u0C80-\u0CFF]/g, 'kn-IN'],
  [/[\u0D00-\u0D7F]/g, 'ml-IN'],
];

const MARATHI_MARKERS = /(आहे|आहेत|माझ[ाेी]|मला|आणि|नाही|काय|झाल[ाे]|करू|पाहिजे|आम्ही|तुम्ही|कसे|किती)/;

// The language a message is written in, judged by its script. Latin text (English or Hinglish) returns null.
export function detectLanguage(text: string, preferred?: string | null): LanguageCode | null {
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  let best: LanguageCode | null = null;
  let count = 0;
  for (const [pattern, code] of SCRIPTS) {
    const found = text.match(pattern)?.length ?? 0;
    if (found > count) {
      best = code;
      count = found;
    }
  }
  if (!best || count < 2 || count < letters * 0.3) return null;
  if (best === 'hi-IN' && (preferred === 'mr-IN' || MARATHI_MARKERS.test(text))) return 'mr-IN';
  return best;
}

export const languageName = (code: string | null | undefined): string => LANGUAGES[(code ?? 'en-IN') as LanguageCode] ?? 'English';
export const promptLanguage = (code: string | null | undefined): string =>
  LANGUAGE_PROMPT_NAMES[(code ?? 'en-IN') as LanguageCode] ?? 'English';

export const translationAvailable = (): boolean => sarvamAvailable() || openaiAvailable();

// The customer's words in English for Saathi's understanding. Amounts are not guarded here: "दो लाख" may
// legitimately become "2 lakh". Returns null when no translation service can be reached.
export async function toEnglish(text: string, source: LanguageCode): Promise<{ text: string; via: 'sarvam' | 'openai' } | null> {
  const input = asciiDigits(text);
  if (sarvamAvailable()) {
    try {
      return { text: await translateWithSarvam(input, 'en-IN', source, false), via: 'sarvam' };
    } catch {
      // fall through to the next translator
    }
  }
  if (openaiAvailable()) {
    try {
      return { text: await translateWithOpenAI(input, promptLanguage(source), 'English', false), via: 'openai' };
    } catch {
      return null;
    }
  }
  return null;
}

// Saathi's English reply in the customer's language. Any translation that changes an amount is discarded,
// so the customer always sees the amounts the deterministic engines produced.
export async function fromEnglish(text: string, target: string): Promise<string | null> {
  if (!text.trim() || target === 'en-IN') return null;
  if (sarvamAvailable()) {
    try {
      return await translateWithSarvam(text, target);
    } catch {
      // fall through to the next translator
    }
  }
  if (openaiAvailable()) {
    try {
      return await translateWithOpenAI(text, 'English', promptLanguage(target));
    } catch {
      return null;
    }
  }
  return null;
}
