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

// How to ask a model for each language, so replies come back in native script rather than romanised text.
export const LANGUAGE_PROMPT_NAMES: Record<keyof typeof LANGUAGES, string> = {
  'en-IN': 'English',
  'hi-IN': 'Hindi, written in Devanagari script',
  'bn-IN': 'Bengali, written in Bengali script',
  'ta-IN': 'Tamil, written in Tamil script',
  'te-IN': 'Telugu, written in Telugu script',
  'mr-IN': 'Marathi, written in Devanagari script',
  'gu-IN': 'Gujarati, written in Gujarati script',
  'kn-IN': 'Kannada, written in Kannada script',
  'ml-IN': 'Malayalam, written in Malayalam script',
  'pa-IN': 'Punjabi, written in Gurmukhi script',
  'od-IN': 'Odia, written in Odia script',
};

export type LanguageCode = keyof typeof LANGUAGES;
export const LANGUAGE_CODES = Object.keys(LANGUAGES) as [LanguageCode, ...LanguageCode[]];

export const isLanguageCode = (value: unknown): value is LanguageCode => typeof value === 'string' && value in LANGUAGES;
