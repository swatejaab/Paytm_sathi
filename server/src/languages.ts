// Languages Saathi can listen, reply, and speak in. Codes are Sarvam BCP-47 codes.
export const LANGUAGES = {
  'en-IN': 'English',
  'hi-IN': 'Hindi',
  'bn-IN': 'Bengali',
  'ta-IN': 'Tamil',
  'te-IN': 'Telugu',
  'mr-IN': 'Marathi',
  'gu-IN': 'Gujarati',
  'kn-IN': 'Kannada',
  'ml-IN': 'Malayalam',
  'pa-IN': 'Punjabi',
  'od-IN': 'Odia',
} as const;

export type LanguageCode = keyof typeof LANGUAGES;
export const LANGUAGE_CODES = Object.keys(LANGUAGES) as [LanguageCode, ...LanguageCode[]];

export const isLanguageCode = (value: unknown): value is LanguageCode => typeof value === 'string' && value in LANGUAGES;
