import { addMessage } from '../caseStore';
import { sarvamAvailable } from '../config';
import { translateWithSarvam } from '../integrations';
import type { CaseRecord, ChatMessage } from '../types';

// Translates a deterministic assistant message into the customer's chosen language.
// Falls back to the English original if Sarvam is off or the call fails.
export async function addLocalizedMessage(
  record: CaseRecord,
  text: string,
  extra: Pick<ChatMessage, 'quick_replies' | 'card'> = {},
): Promise<void> {
  const target = record.preferred_language;
  if (!target || target === 'en-IN' || !sarvamAvailable()) {
    addMessage(record, 'assistant', text, extra);
    return;
  }
  try {
    const translated = await translateWithSarvam(text, target);
    addMessage(record, 'assistant', translated, { ...extra, original: text, language: target });
  } catch {
    addMessage(record, 'assistant', text, { ...extra, language: 'en-IN' });
  }
}
