import { accountFacts } from '../accountContext';
import { addMessage } from '../caseStore';
import { openaiAvailable } from '../config';
import { recordAudit, standingConsents } from '../db';
import { checkedAccountAnswer } from '../integrations';
import { isLanguageCode, LANGUAGE_PROMPT_NAMES } from '../languages';
import { redactContactIdentifiers } from '../redaction';
import type { CaseRecord } from '../types';
import { addLocalizedMessage } from './localize';

// Facts the assistant may use: the deterministic decision, evidence citations, and the case status. No raw documents.
export function chatFacts(record: CaseRecord) {
  const decision = record.decision;
  return {
    event: record.event_type,
    status: record.status,
    story: redactContactIdentifiers(record.customer_message),
    calculation: decision?.calculation ?? null,
    facts: decision?.facts.map(({ label, value, unit, source }) => ({ label, value, unit, source: source.ref })) ?? [],
    options: decision?.options.map((option) => ({
      title: option.title,
      recommended: option.recommended,
      feasible: option.feasible,
      score: option.scores.total,
      summary: option.summary,
      metrics: option.metrics,
      trade_offs: option.trade_offs,
      blocked_by: option.guardrails.filter((guardrail) => !guardrail.passed).map((guardrail) => guardrail.detail),
    })) ?? [],
    explanation: decision?.explanation ?? null,
    warnings: decision?.warnings ?? [],
    missing_documents: record.evidence?.missing_documents ?? [],
    citations: (record.evidence?.retrieved_evidence ?? []).map((passage) => ({
      document: passage.document_name,
      clause: passage.clause_id,
      page: passage.page,
      title: passage.title,
    })),
    latest_timeline: record.timeline.slice(-5).map((entry) => entry.title),
  };
}

export function replyLanguage(record: CaseRecord, requested?: string): { code?: string; name: string } {
  const code = requested ?? record.preferred_language;
  if (isLanguageCode(code)) return { code, name: LANGUAGE_PROMPT_NAMES[code] };
  return { name: record.language === 'hinglish' ? 'Hinglish (Hindi in Latin script)' : 'English' };
}

// The customer allowed AI answers for this case, or switched them on for every case in Profile.
export function aiAllowed(record: CaseRecord): boolean {
  return openaiAvailable() && (Boolean(record.ai_answers) || standingConsents(record.customer_id).ai);
}

export interface ComposeInput {
  question: string;
  draft?: string; // the calculated answer; also the fallback when AI is off or rejected
  knowledge?: string | null;
  withCase?: boolean;
  language?: string;
  fallback?: string; // used instead of the draft when AI is off or its reply is rejected
  consented?: boolean; // this request itself carries the customer's AI consent
  facts?: unknown; // calculated facts for this question, used instead of the case facts
}

// Writes the assistant's reply. With AI allowed, OpenAI answers from the customer's own account data and the
// calculated facts; any number it adds that is not in those inputs rejects the reply and the calculated text is used.
export async function composeReply(record: CaseRecord, input: ComposeInput): Promise<'openai' | 'saathi'> {
  const fallback = async () => {
    const text = input.fallback ?? input.draft;
    if (text) await addLocalizedMessage(record, text);
    return 'saathi' as const;
  };
  if (!(input.consented ? openaiAvailable() : aiAllowed(record))) return fallback();
  const account = accountFacts(record.customer_id);
  const caseFacts = input.facts ?? (input.withCase === false ? null : chatFacts(record));
  const language = replyLanguage(record, input.language);
  try {
    const result = await checkedAccountAnswer({
      question: input.question,
      languageName: language.name,
      account,
      caseFacts,
      draft: input.draft,
      knowledge: input.knowledge ?? null,
    });
    if (result.rejected.length) {
      recordAudit({
        case_id: record.case_id,
        actor: 'saathi',
        event: result.answer ? 'ai_answer_corrected' : 'ai_answer_rejected',
        decision: result.answer ? 'allow' : 'deny',
        detail: { reason: 'invented_numbers', numbers: result.rejected.slice(0, 5), attempts: result.attempts },
      });
    }
    if (!result.answer) return fallback();
    addMessage(record, 'assistant', result.answer, { source: 'openai', ...(language.code ? { language: language.code } : {}) });
    recordAudit({
      case_id: record.case_id,
      actor: 'saathi',
      event: 'external_ai_chat',
      detail: { provider: 'openai', consent_purpose: 'answer_with_account_facts', used_account_facts: Boolean(account) },
    });
    return 'openai';
  } catch {
    return fallback();
  }
}
