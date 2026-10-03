import { fromEnglish } from '../assistant/language';
import { addMessage } from '../caseStore';
import type { CaseRecord, ChatMessage } from '../types';

// Translates a deterministic assistant message (and its reply chips) into the customer's language: Sarvam first,
// then OpenAI. Falls back to the English original if neither is available or a translation changes an amount.
export async function addLocalizedMessage(
  record: CaseRecord,
  text: string,
  extra: Pick<ChatMessage, 'quick_replies' | 'card'> = {},
): Promise<void> {
  const target = record.preferred_language;
  if (!target || target === 'en-IN') {
    addMessage(record, 'assistant', text, extra);
    return;
  }
  const [translated, labels] = await Promise.all([
    fromEnglish(text, target),
    Promise.all((extra.quick_replies ?? []).map((reply) => fromEnglish(reply.label, target))),
  ]);
  const quickReplies = extra.quick_replies?.map((reply, index) => ({ ...reply, label: labels[index] || reply.label }));
  if (!translated) {
    addMessage(record, 'assistant', text, { ...extra, ...(quickReplies ? { quick_replies: quickReplies } : {}), language: 'en-IN' });
    return;
  }
  addMessage(record, 'assistant', translated, { ...extra, ...(quickReplies ? { quick_replies: quickReplies } : {}), original: text, language: target });
}
