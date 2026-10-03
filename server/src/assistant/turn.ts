// One conversation turn: understand the message, update what Saathi knows, ask for anything missing,
// run the deterministic engines, and explain. Financial values come only from the customer, their uploads,
// or their records (after consent). Saathi never fills a gap with a preset case.
import { runAgent } from '../agent/graph';
import { addLocalizedMessage } from '../agent/localize';
import { assessAffordability, purchaseCategory, type AffordabilityAssessment } from '../afford';
import { addMessage, addTimeline, grantRecordsConsent, hasConsent, loadCaseForOwner, newId } from '../caseStore';
import { openaiAvailable } from '../config';
import { insertCase, nowIso, recordAudit, standingConsents, updateCase } from '../db';
import { formatDay, formatInr } from '../decision';
import { financialContext } from '../financialContext';
import { activeGoals, computeGoal, type Goal, type GoalType } from '../goals';
import { buildInsights } from '../insights';
import { allowedNumbers, answerCaseQuestion, inventedNumbers } from '../integrations';
import { redactContactIdentifiers } from '../redaction';
import { playbookForEvent } from '../playbooks/registry';
import { buildTwin } from '../twin';
import type {
  CaseRecord,
  ChatCard,
  ContextSlots,
  ConversationContext,
  EventType,
  GapLine,
  GoalDraft,
  JourneyId,
  Principal,
  QuickReply,
  SlotSource,
  UploadedDocument,
  Urgency,
} from '../types';
import { normalizeText, parseAmounts, understand, type Understanding } from './nlu';
import { admissionPhrase, fetchHospitalRecords, payNowSource } from './records';

const CASE_JOURNEYS = new Set<JourneyId>(['hospital', 'bill', 'upi_fraud', 'failed_refund', 'emi', 'protection']);

const JOURNEY_EVENTS: Partial<Record<JourneyId, { event: EventType; urgency: Urgency }>> = {
  hospital: { event: 'hospitalization', urgency: 'high' },
  upi_fraud: { event: 'upi_dispute', urgency: 'high' },
  failed_refund: { event: 'failed_refund', urgency: 'medium' },
  emi: { event: 'emi_shortfall', urgency: 'medium' },
  protection: { event: 'protection', urgency: 'low' },
};

const JOURNEY_TITLES: Partial<Record<JourneyId, string>> = {
  hospital: 'Hospital Bill Assistance',
  bill: 'Bill Payment Help',
  upi_fraud: 'Unknown UPI Transaction',
  failed_refund: 'Failed Payment Refund',
  emi: 'EMI Payment Problem',
  protection: 'Life Insurance Check',
  specialist: 'Talk to a Specialist',
};

export const NEW_CHAT_TITLE = 'New chat';
export const GENERIC_ERROR = 'Something went wrong while processing your request. Please try again.';

const PLAN_REPLIES: QuickReply[] = [
  { label: 'View full plan', action: 'open_plan' },
  { label: 'Why this plan?', send: 'Why this plan?' },
  { label: 'Talk to a specialist', action: 'handoff' },
];

export function emptyContext(): ConversationContext {
  return { journey: null, slots: {}, awaiting: null, missing: [], gap: null, updated_at: nowIso() };
}

export function createConversation(principal: Principal, preferredLanguage?: string): CaseRecord {
  const now = nowIso();
  const record: CaseRecord = {
    case_id: newId('SA'),
    customer_id: principal.sub,
    title: NEW_CHAT_TITLE,
    context: emptyContext(),
    event_type: 'general_financial_support',
    urgency: 'low',
    language: 'en',
    ...(preferredLanguage && preferredLanguage !== 'en-IN' ? { preferred_language: preferredLanguage } : {}),
    status: 'intake',
    customer_message: '',
    assistant_message: '',
    created_at: now,
    updated_at: now,
    messages: [],
    consents: [],
    evidence: null,
    uploaded_documents: [],
    pending_question: null,
    decision: null,
    actions: [],
    timeline: [],
    ai_analysis: null,
    agent_runs: [],
  };
  insertCase(record);
  return record;
}

interface Turn {
  record: CaseRecord;
  principal: Principal;
  ctx: ConversationContext;
  u: Understanding;
  text: string;
}

const hinglish = (record: CaseRecord) => record.language === 'hinglish';
const say = (record: CaseRecord, en: string, hi?: string) => (hinglish(record) && hi ? hi : en);
const quote = (text: string) => `You said: "${text.length > 70 ? `${text.slice(0, 67)}...` : text}"`;

async function reply(record: CaseRecord, text: string, extra: { quick_replies?: QuickReply[]; card?: ChatCard } = {}) {
  await addLocalizedMessage(record, text, extra);
}

function setSlot<K extends keyof ContextSlots>(
  ctx: ConversationContext,
  key: K,
  value: NonNullable<ContextSlots[K]>['value'],
  source: SlotSource,
  ref: string,
  confidence: number,
): void {
  ctx.slots[key] = { value, source, ref, confidence, updated_at: nowIso() } as ContextSlots[K];
}

function firstName(principal: Principal): string {
  return principal.display_name.split(/\s+/)[0] ?? '';
}

function setJourney(turn: Turn, journey: JourneyId): void {
  const { record, ctx } = turn;
  ctx.journey = journey;
  const mapped = JOURNEY_EVENTS[journey];
  if (mapped && record.event_type !== mapped.event) {
    record.event_type = mapped.event;
    record.urgency = mapped.urgency;
    record.playbook_id = playbookForEvent(mapped.event).id;
  }
}

// Records consent is asked once per conversation; a remembered choice from More > Consent management applies here too.
function ensureRecordsConsent(turn: Turn): boolean {
  const { record, principal } = turn;
  if (hasConsent(record, 'prepare_resolution_options')) return true;
  const revokedHere = record.consents.some((consent) => consent.status === 'revoked');
  if (!revokedHere && standingConsents(principal.sub).records) {
    grantRecordsConsent(record, principal, true);
    return true;
  }
  return false;
}

type AfterConsent = NonNullable<ConversationContext['after_consent']>;

async function askRecordsConsent(turn: Turn, purpose: string, after: AfterConsent, lead = '') {
  turn.ctx.awaiting = 'records_consent';
  turn.ctx.after_consent = after;
  await reply(
    turn.record,
    `${lead}${lead ? ' ' : ''}${say(
      turn.record,
      `${purpose} I need your permission to read your account records for this conversation. Saathi only reads what this question needs, and nothing is shared or submitted without your approval.`,
      `${purpose} Iske liye mujhe is conversation ke liye aapke account records padhne ki permission chahiye. Aapke approve kiye bina kuch bhi share ya submit nahi hoga.`,
    )}`,
    {
      quick_replies: [
        { label: say(turn.record, 'Allow access', 'Haan, allow karein'), send: 'Yes, allow access' },
        { label: say(turn.record, 'Not now', 'Abhi nahi'), send: 'Not now' },
      ],
    },
  );
}

function lastAssistant(record: CaseRecord) {
  return [...record.messages].reverse().find((message) => message.role === 'assistant');
}

// After the agent graph runs, attach the right card to its message so the chat can show the plan or picker inline.
function decorateAfterRun(record: CaseRecord, prefix = ''): void {
  const message = lastAssistant(record);
  if (!message) return;
  if (prefix) {
    message.content = `${prefix} ${message.content}`;
    record.assistant_message = message.content;
  }
  if (record.pending_question?.type === 'confirm_transaction') {
    message.card = { type: 'transactions' };
    message.quick_replies = [{ label: 'Talk to a specialist', action: 'handoff' }];
  } else if (record.decision) {
    message.card = { type: 'plan' };
    const options = new Set(record.decision.options.filter((option) => option.feasible).map((option) => option.option_id));
    message.quick_replies =
      record.decision.event_type === 'upi_dispute' && options.has('dispute_and_protect')
        ? [
            { label: 'Raise dispute', action: 'prepare_option', payload: { option_id: 'dispute_and_protect' } },
            ...(options.has('secure_account') ? [{ label: 'Secure my account', action: 'prepare_option', payload: { option_id: 'secure_account' } } as QuickReply] : []),
            { label: 'View transaction', action: 'open_plan', payload: { tab: 'evidence' } },
            { label: 'Report transaction', action: 'report_transaction' },
            { label: 'Contact support', action: 'handoff' },
          ]
        : PLAN_REPLIES;
  }
}

async function runCaseGraph(turn: Turn, prefix = ''): Promise<void> {
  const { record, principal } = turn;
  const firstRun = !(record.agent_runs ?? []).some((run) => run.trigger === 'intake');
  await runAgent(record, principal, firstRun ? 'intake' : 'details_updated');
  decorateAfterRun(record, prefix);
}

// ---------- hospital and medical bills ----------

const NOTHING = /\b(nothing|zero|none|no money|kuch nahi|kuchh nahi|nahi de sakta|nahi de sakti|can'?t pay|cannot pay|nil)\b/i;

function absorbHospital(turn: Turn): { changed: boolean; ambiguous: number | null } {
  const { ctx, u, text } = turn;
  const slots = ctx.slots;
  let changed = false;
  const unassigned: number[] = [];
  const assign = (role: 'bill' | 'insurance' | 'self_pay', value: number) => {
    if (role === 'bill') {
      if (slots.bill_inr && slots.bill_inr.value !== value) changed = true;
      setSlot(ctx, 'bill_inr', value, 'customer_statement', quote(text), 0.9);
    } else if (role === 'insurance') {
      if (slots.insurance_cover_inr && slots.insurance_cover_inr.value !== value) changed = true;
      setSlot(ctx, 'insurance_cover_inr', value, 'customer_statement', quote(text), 0.8);
      setSlot(ctx, 'has_insurance', true, 'customer_statement', quote(text), 1);
    } else {
      if (slots.self_pay_inr && slots.self_pay_inr.value !== value) changed = true;
      setSlot(ctx, 'self_pay_inr', value, 'customer_statement', quote(text), 1);
    }
  };
  for (const amount of u.amounts) {
    const role = amount.role;
    if (role === 'bill' || role === 'price' || role === 'target') assign('bill', amount.value);
    else if (role === 'insurance') assign('insurance', amount.value);
    else if (role === 'self_pay' || role === 'saved') assign('self_pay', amount.value);
    else if (role === null || role === 'debit') unassigned.push(amount.value);
  }
  for (const value of unassigned) {
    if (ctx.awaiting === 'bill_inr' || (!slots.bill_inr && !turn.record.confirmed_bill)) assign('bill', value);
    else if (ctx.awaiting === 'insurance_cover_inr') assign('insurance', value);
    else if (ctx.awaiting === 'self_pay_inr') assign('self_pay', value);
    else return { changed, ambiguous: value };
  }
  if (ctx.awaiting === 'self_pay_inr' && !u.amounts.length && NOTHING.test(text)) assign('self_pay', 0);
  if (u.planWithoutInsurance) {
    setSlot(ctx, 'has_insurance', false, 'customer_choice', 'You chose to plan without insurance for now', 1);
    delete slots.insurance_cover_inr;
    changed = true;
  } else if (u.hasInsurance === false) {
    if (slots.has_insurance?.value) changed = true;
    setSlot(ctx, 'has_insurance', false, 'customer_statement', quote(text), 1);
    delete slots.insurance_cover_inr;
  } else if (u.hasInsurance === true) {
    setSlot(ctx, 'has_insurance', true, 'customer_statement', quote(text), 1);
  } else if (ctx.awaiting === 'has_insurance' && (u.yes || u.no)) {
    setSlot(ctx, 'has_insurance', u.yes, 'customer_statement', quote(text), 1);
  }
  if (ctx.journey === 'bill' && (u.medical || (ctx.awaiting === 'bill_kind' && u.yes) || slots.has_insurance)) {
    ctx.journey = 'hospital';
  }
  return { changed, ambiguous: null };
}

function gapPreview(ctx: ConversationContext): { lines: GapLine[]; gap: number; formula: string } | null {
  const { bill_inr: bill, has_insurance: insured, insurance_cover_inr: cover, self_pay_inr: self } = ctx.slots;
  if (!bill || !insured || !self || (insured.value && !cover)) return null;
  const coverValue = insured.value ? Math.min(cover!.value, bill.value) : 0;
  const gap = Math.max(bill.value - coverValue - self.value, 0);
  const lines: GapLine[] = [{ label: 'Hospital bill', amount_inr: bill.value, op: '', source: bill.ref }];
  if (insured.value) lines.push({ label: 'Expected insurance cover', amount_inr: coverValue, op: '-', source: cover!.ref });
  lines.push({ label: 'You can pay now', amount_inr: self.value, op: '-', source: self.ref });
  lines.push({ label: 'Funding gap', amount_inr: gap, op: '=', source: 'max(bill - insurance - your payment, 0)' });
  return { lines, gap, formula: 'max(bill - insurance cover - what you can pay, 0)' };
}

// Uses the hospital's own itemised bill for the current admission as the bill for this plan.
function useAdmissionBill(turn: Turn): void {
  const { record, ctx } = turn;
  const admission = ctx.records?.admission;
  if (!admission) return;
  const stated = ctx.slots.bill_inr?.source === 'customer_statement' ? ctx.slots.bill_inr.value : null;
  if (stated && stated !== admission.total_inr) ctx.stated_bill_inr = stated;
  record.confirmed_bill = {
    document_id: admission.document_id,
    document_name: admission.document_name,
    total_inr: admission.total_inr,
    lines: admission.lines,
    confirmed_at: nowIso(),
  };
  setSlot(ctx, 'bill_inr', admission.total_inr, 'hospital_record', admission.document_name, 0.95);
}

// Reads the policy, admission and bank records once per conversation, then fills only what the customer has not said.
async function loadHospitalRecords(turn: Turn): Promise<void> {
  const { record, principal, ctx } = turn;
  if (!ctx.records) {
    ctx.records = await fetchHospitalRecords(record, principal);
    const { policy, admission, cash } = ctx.records;
    addTimeline(record, {
      title: 'Records checked with your consent',
      detail: [
        policy ? `Insurer: ${policy.policy_name} found` : 'Insurer: no health policy on file',
        admission ? `Hospital: ${admission.document_name}, ${formatInr(admission.total_inr)}` : 'Hospital: no admission on record',
        cash ? `Bank (Account Aggregator): ${formatInr(cash.safe_to_pay_inr)} free before salary` : 'Bank: not available',
      ].join('. ') + '.',
      actor: 'saathi',
    });
  }
  const { policy, cash } = ctx.records;
  const slots = ctx.slots;
  if (policy) {
    const ref = `${policy.policy_name}, ${policy.insurer}`;
    if (!slots.policy_sum_insured_inr) setSlot(ctx, 'policy_sum_insured_inr', policy.sum_insured_inr, 'insurer_record', ref, 0.95);
    if (!slots.has_insurance) setSlot(ctx, 'has_insurance', true, 'insurer_record', ref, 0.95);
  }
  if (cash && !slots.self_pay_inr) setSlot(ctx, 'self_pay_inr', cash.safe_to_pay_inr, 'account_records', payNowSource(cash), 0.9);
}

// "I checked your Family health floater with the insurer, City Hospital, Thane's bill for your father's ICU stay, and your bank balance."
function recordsLead(record: CaseRecord, ctx: ConversationContext): string {
  const found = ctx.records;
  if (!found) return '';
  const checked = [
    found.policy && ctx.slots.has_insurance?.value ? say(record, `your ${found.policy.policy_name} with the insurer`, `insurer ke saath aapki ${found.policy.policy_name} policy`) : null,
    found.admission && record.confirmed_bill?.document_id === found.admission.document_id
      ? say(record, `${found.admission.hospital}'s bill for ${admissionPhrase(found.admission).replace(/ at .*$/, '')}`, `${found.admission.hospital} ka bill`)
      : null,
    found.cash && ctx.slots.self_pay_inr?.source === 'account_records' ? say(record, 'your bank balance through Account Aggregator', 'Account Aggregator se aapka bank balance') : null,
  ].filter(Boolean) as string[];
  if (!checked.length) return '';
  const list = checked.length > 1 ? `${checked.slice(0, -1).join(', ')} and ${checked.at(-1)}` : checked[0];
  return say(record, `I checked ${list}.`, `Maine ${list.replace(' and ', ' aur ')} check kiya.`);
}

async function advanceHospital(turn: Turn, opts: { updated?: boolean } = {}): Promise<void> {
  const { record, ctx } = turn;
  const slots = ctx.slots;
  ctx.missing = [];
  const consented = ctx.journey === 'hospital' && ensureRecordsConsent(turn);
  if (consented) await loadHospitalRecords(turn);

  const admission = ctx.records?.admission;
  if (admission && ctx.journey === 'hospital' && !ctx.hospital_bill_declined && record.confirmed_bill?.document_id !== admission.document_id) {
    const stated = record.confirmed_bill ? null : (slots.bill_inr?.value ?? null);
    if (!record.confirmed_bill && (stated === null || stated === admission.total_inr)) {
      useAdmissionBill(turn);
    } else if (stated !== null) {
      ctx.awaiting = 'bill_choice';
      await reply(
        record,
        say(
          record,
          `${admission.hospital} has a bill of ${formatInr(admission.total_inr)} on record for ${admissionPhrase(admission).replace(/ at .*$/, '')}, but you mentioned ${formatInr(stated)}. Which bill should I plan for?`,
          `${admission.hospital} ke record mein ${formatInr(admission.total_inr)} ka bill hai, lekin aapne ${formatInr(stated)} bataya. Main kis bill ke liye plan banaun?`,
        ),
        {
          quick_replies: [
            { label: say(record, `Use the hospital's ${formatInr(admission.total_inr)} bill`, `Hospital ka ${formatInr(admission.total_inr)} bill`), send: `Use the hospital's ${formatInr(admission.total_inr)} bill` },
            { label: say(record, `Plan for ${formatInr(stated)}`, `${formatInr(stated)} ke liye plan`), send: `Plan for my ${formatInr(stated)} bill` },
          ],
        },
      );
      return;
    }
  }

  const billValue = record.confirmed_bill?.total_inr ?? slots.bill_inr?.value;
  if (!billValue) {
    if (ctx.journey === 'hospital' && !consented && !ctx.records_consent_declined) {
      await askRecordsConsent(
        turn,
        say(
          record,
          "So you don't have to type it all in, I can check your health policy with your insurer, the hospital's bill, and what you can safely pay from your bank balance.",
          'Aapko sab type na karna pade, isliye main insurer se aapki health policy, hospital ka bill, aur bank balance se aap kitna de sakte hain, check kar sakta hoon.',
        ),
        'plan',
        say(record, "I'm sorry you're dealing with this. I'm here to help.", 'Aap pareshaan honge, main madad karta hoon.'),
      );
      lastAssistant(record)!.quick_replies?.splice(1, 0, { label: say(record, 'Upload bill instead', 'Bill upload karein'), action: 'upload_bill' });
      return;
    }
    ctx.awaiting = 'bill_inr';
    ctx.missing = ['bill amount'];
    await reply(
      record,
      ctx.records
        ? say(
            record,
            "I couldn't find a hospital admission linked to your account. How much is the hospital bill, or the estimate the hospital has given you? You can also upload the bill and I'll read it.",
            'Aapke account se juda koi hospital admission nahi mila. Hospital ka bill ya estimate kitna hai? Aap bill upload bhi kar sakte hain.',
          )
        : say(
            record,
            "I'm sorry you're dealing with this. How much is the hospital bill, or the estimate the hospital has given you? You can also upload the bill and I'll read it.",
            'Aap pareshaan honge, main madad karta hoon. Hospital ka bill ya estimate kitna hai? Aap bill upload bhi kar sakte hain, main padh lunga.',
          ),
      { quick_replies: [{ label: 'Upload bill', action: 'upload_bill' }, { label: 'Talk to a specialist', action: 'handoff' }] },
    );
    return;
  }
  if (ctx.journey === 'hospital' && !consented && !ctx.records_consent_declined) {
    await askRecordsConsent(
      turn,
      say(
        record,
        "So you don't have to type in your policy and bank details, I can check your health policy with your insurer, the hospital's bill, and what you can safely pay from your bank balance.",
        'Aapko policy aur bank details type na karni padein, isliye main insurer se aapki health policy, hospital ka bill, aur bank balance check kar sakta hoon.',
      ),
      'plan',
      say(record, `I understand your hospital bill is ${formatInr(billValue)}.`, `Samajh gaya, hospital ka bill ${formatInr(billValue)} hai.`),
    );
    return;
  }
  if (ctx.journey === 'bill') {
    ctx.awaiting = 'bill_kind';
    await reply(
      record,
      say(record, `Got it: a bill of ${formatInr(billValue)}. Is this a hospital or medical bill?`, `Samajh gaya: ${formatInr(billValue)} ka bill. Kya ye hospital ya medical bill hai?`),
      {
        quick_replies: [
          { label: "Yes, it's medical", send: "Yes, it's a hospital bill" },
          { label: 'No, another bill', send: "No, it's not a medical bill" },
        ],
      },
    );
    return;
  }
  if (!slots.has_insurance) {
    ctx.awaiting = 'has_insurance';
    ctx.missing = ['insurance', 'what you can pay now'];
    const policyNote = ctx.records && !ctx.records.policy ? say(record, ' I could not find a health policy on file with our insurer partners.', ' Insurer partners ke paas aapki koi health policy nahi mili.') : '';
    await reply(
      record,
      say(
        record,
        `I understand your hospital bill is ${formatInr(billValue)}. Do you have health insurance? If yes, upload your policy or tell me the expected coverage.${policyNote}`,
        `Samajh gaya, hospital ka bill ${formatInr(billValue)} hai. Kya aapke paas health insurance hai? Agar haan, toh policy upload kijiye ya expected coverage bataiye.${policyNote}`,
      ),
      {
        quick_replies: [
          { label: 'Yes, I have insurance', send: 'Yes, I have health insurance' },
          { label: 'No insurance', send: "No, I don't have insurance" },
          { label: 'Upload policy', action: 'upload_policy' },
        ],
      },
    );
    return;
  }
  if (slots.has_insurance.value && !slots.insurance_cover_inr && !record.confirmed_bill) {
    ctx.awaiting = 'insurance_cover_inr';
    ctx.missing = ['expected insurance cover', ...(slots.self_pay_inr ? [] : ['what you can pay now'])];
    if (turn.u.dontKnow) {
      await reply(
        record,
        say(
          record,
          "That's okay. I couldn't confidently determine your coverage, and I won't guess it. You can upload your policy or the hospital's estimate for me to read, ask the hospital's insurance (TPA) desk for the pre-authorised amount, or plan without insurance for now and update it later.",
          'Koi baat nahi. Main coverage ka andaaza nahi lagaunga. Aap policy ya hospital ka estimate upload kar sakte hain, hospital ke TPA desk se pre-authorised amount pooch sakte hain, ya abhi bina insurance ke plan bana sakte hain.',
        ),
        {
          quick_replies: [
            { label: 'Upload policy', action: 'upload_policy' },
            { label: 'Plan without insurance for now', send: 'Plan without insurance for now' },
            { label: 'Talk to a specialist', action: 'handoff' },
          ],
        },
      );
      return;
    }
    const policy = ctx.records?.policy;
    if (policy && slots.has_insurance.source === 'insurer_record') {
      await reply(
        record,
        say(
          record,
          `I found your ${policy.policy_name} with ${policy.insurer}, with a sum insured of ${formatInr(policy.sum_insured_inr)}. That is the most it can pay, not what this bill will get. To check what it covers, upload the itemised bill, or tell me the amount the hospital's insurance (TPA) desk pre-authorised.`,
          `Aapki ${policy.policy_name} policy mili (${policy.insurer}), sum insured ${formatInr(policy.sum_insured_inr)}. Ye maximum hai, is bill ka cover nahi. Cover check karne ke liye itemised bill upload kijiye, ya hospital ke TPA desk ka pre-authorised amount bataiye.`,
        ),
        {
          quick_replies: [
            { label: 'Upload bill', action: 'upload_bill' },
            { label: "I'm not sure", send: "I don't know how much insurance will cover" },
            { label: 'Plan without insurance for now', send: 'Plan without insurance for now' },
          ],
        },
      );
      return;
    }
    await reply(
      record,
      say(
        record,
        "How much do you expect your insurance to cover for this bill? If you're not sure, upload the policy or the hospital's pre-authorisation and I'll check it.",
        'Aapko kitna lagta hai insurance is bill ka cover karega? Agar pata nahi, toh policy ya pre-authorisation upload kijiye.',
      ),
      {
        quick_replies: [
          { label: "I'm not sure", send: "I don't know how much insurance will cover" },
          { label: 'Upload policy', action: 'upload_policy' },
          { label: 'Plan without insurance for now', send: 'Plan without insurance for now' },
        ],
      },
    );
    return;
  }
  if (!slots.self_pay_inr) {
    ctx.awaiting = 'self_pay_inr';
    ctx.missing = ['what you can pay now'];
    await reply(
      record,
      say(
        record,
        'How much can you pay from your own funds right now, without touching money you need for essentials?',
        'Aap abhi apne paison se kitna de sakte hain, zaroori kharchon ka paisa chhodkar?',
      ),
      { quick_replies: [{ label: 'Nothing right now', send: "I can't pay anything right now" }] },
    );
    return;
  }

  ctx.awaiting = null;
  const preview = gapPreview(ctx);
  if (preview) ctx.gap = {
    bill_total_inr: preview.lines[0]!.amount_inr,
    coverage_estimate_inr: slots.has_insurance.value ? preview.lines[1]!.amount_inr : 0,
    customer_contribution_inr: slots.self_pay_inr.value,
    exact_gap_inr: preview.gap,
    formula: preview.formula,
  };
  if (!ensureRecordsConsent(turn)) {
    const lead = preview
      ? preview.gap > 0
        ? say(
            record,
            `Here's the math: ${formatInr(preview.lines[0]!.amount_inr)} bill${slots.has_insurance.value ? ` - ${formatInr(preview.lines[1]!.amount_inr)} expected insurance` : ''} - ${formatInr(slots.self_pay_inr.value)} you can pay = a funding gap of ${formatInr(preview.gap)}.`,
            `Hisaab: ${formatInr(preview.lines[0]!.amount_inr)} bill${slots.has_insurance.value ? ` - ${formatInr(preview.lines[1]!.amount_inr)} insurance` : ''} - ${formatInr(slots.self_pay_inr.value)} jo aap de sakte hain = ${formatInr(preview.gap)} ka gap.`,
          )
        : say(record, 'Good news: insurance and what you can pay cover the whole bill, so there is no gap to fund.', 'Achhi khabar: insurance aur aapka hissa poora bill cover kar dete hain.')
      : '';
    if (turn.ctx.records_consent_declined && !turn.u.yes) {
      await reply(
        record,
        `${lead} ${say(record, 'I can compare options for you whenever you allow access to your records.', 'Jab aap permission denge, main options compare kar dunga.')}`.trim(),
        {
          ...(preview ? { card: { type: 'gap', lines: preview.lines, formula: preview.formula } as ChatCard } : {}),
          quick_replies: [{ label: 'Allow access', send: 'Yes, allow access' }, { label: 'Talk to a specialist', action: 'handoff' }],
        },
      );
      return;
    }
    const purpose =
      preview && preview.gap > 0
        ? say(record, `To compare ways to cover the ${formatInr(preview.gap)} (savings, a repayment plan, or help from the hospital),`, `${formatInr(preview.gap)} cover karne ke tareeke compare karne ke liye,`)
        : say(record, 'To prepare the claim and payment steps,', 'Claim aur payment steps taiyaar karne ke liye,');
    await askRecordsConsent(turn, purpose, 'plan', lead);
    if (preview) lastAssistant(record)!.card = { type: 'gap', lines: preview.lines, formula: preview.formula };
    return;
  }
  await runCaseGraph(
    turn,
    opts.updated ? say(record, 'I updated your plan with the new details.', 'Maine naye details ke saath plan update kar diya.') : recordsLead(record, ctx),
  );
}

// ---------- UPI, refunds, EMI, protection ----------

async function advanceRecordsJourney(turn: Turn): Promise<void> {
  const { record, ctx } = turn;
  if (record.pending_question?.type === 'confirm_transaction') {
    await reply(record, say(record, 'Please pick the payment from the list so I can check it.', 'List mein se payment chuniye taaki main check kar sakun.'), {
      card: { type: 'transactions' },
    });
    return;
  }
  if (record.decision) {
    await followUp(turn);
    return;
  }
  if (!ensureRecordsConsent(turn)) {
    const debit = ctx.slots.debit_inr?.value;
    if (ctx.journey === 'upi_fraud') {
      await askRecordsConsent(
        turn,
        say(record, `To find the${debit ? ` ${formatInr(debit)}` : ''} payment in your recent UPI transactions,`, `Aapke recent UPI transactions mein${debit ? ` ${formatInr(debit)} ka` : ''} payment dhoondhne ke liye,`),
        'plan',
        say(
          record,
          "I'm sorry this happened. Let's act quickly. If you shared your UPI PIN or an OTP with anyone, you can also call the national cyber fraud helpline on 1930.",
          'Mujhe afsos hai. Jaldi kadam uthate hain. Agar aapne kisi ko UPI PIN ya OTP bataya hai, toh 1930 (cyber fraud helpline) par bhi call kar sakte hain.',
        ),
      );
    } else if (ctx.journey === 'failed_refund') {
      await askRecordsConsent(turn, say(record, 'To find the failed payment in your recent transactions,', 'Failed payment dhoondhne ke liye,'), 'plan');
    } else if (ctx.journey === 'emi') {
      await askRecordsConsent(turn, say(record, "To check your balance and your loan's options (like moving the due date),", 'Aapka balance aur loan ke options (jaise due date badalna) check karne ke liye,'), 'plan', emiAcknowledgement(turn));
    } else {
      await askRecordsConsent(turn, say(record, 'To check your existing cover and household needs,', 'Aapka existing cover check karne ke liye,'), 'plan');
    }
    return;
  }
  const lead = ctx.journey === 'emi' && !record.decision ? emiAcknowledgement(turn) : '';
  await runCaseGraph(turn, lead);
}

function absorbRecordsJourney(turn: Turn): void {
  const { ctx, u, text } = turn;
  for (const amount of u.amounts) {
    if (ctx.journey === 'emi') {
      if (amount.role === 'emi' || amount.role === null) setSlot(ctx, 'emi_inr', amount.value, 'customer_statement', quote(text), 0.9);
    } else if (ctx.journey === 'upi_fraud' || ctx.journey === 'failed_refund') {
      if (amount.role !== 'emi' && amount.role !== 'salary') {
        setSlot(ctx, 'debit_inr', amount.value, 'customer_statement', quote(text), 0.9);
        break;
      }
    }
  }
  if (ctx.journey !== 'emi') return;
  const emiDate = u.dates.find((date) => date.role === 'emi') ?? u.dates.find((date) => date.role === null);
  const salaryDate = u.dates.find((date) => date.role === 'salary');
  if (emiDate) setSlot(ctx, 'emi_due_date', emiDate.date, 'customer_statement', quote(text), 0.9);
  if (salaryDate) {
    let date = salaryDate.date;
    const due = ctx.slots.emi_due_date?.value;
    // "EMI is on Friday but salary comes on Monday" means the Monday after that Friday.
    if (due && date < due && /day$|var$|war$/i.test(salaryDate.raw)) {
      date = new Date(Date.parse(`${date}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
    }
    setSlot(ctx, 'salary_date', date, 'customer_statement', quote(text), 0.9);
  }
}

function emiAcknowledgement(turn: Turn): string {
  const { record, ctx } = turn;
  const due = ctx.slots.emi_due_date?.value;
  const salary = ctx.slots.salary_date?.value;
  const emi = ctx.slots.emi_inr?.value;
  const weekday = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'long', timeZone: 'UTC' });
  if (!due && !salary && !emi) return '';
  const gapDays = due && salary ? Math.round((Date.parse(salary) - Date.parse(due)) / 86_400_000) : null;
  if (hinglish(record)) {
    const parts = [
      emi ? `aapka EMI ${formatInr(emi)} ka hai` : 'aapka EMI',
      due ? `${weekday(due)}, ${formatDay(due)} ko due hai` : '',
      salary ? `aur salary ${weekday(salary)}, ${formatDay(salary)} ko aayegi${gapDays && gapDays > 0 ? `, yaani ${gapDays} din baad` : ''}` : '',
    ].filter(Boolean);
    return `Samajh gaya: ${parts.join(' ')}.`;
  }
  const parts = [
    emi ? `your EMI of ${formatInr(emi)}` : 'your EMI',
    due ? `is due on ${weekday(due)}, ${formatDay(due)}` : '',
    salary ? `and your salary is expected on ${weekday(salary)}, ${formatDay(salary)}${gapDays && gapDays > 0 ? `, ${gapDays} days later` : ''}` : '',
  ].filter(Boolean);
  return `Got it: ${parts.join(' ')}.`;
}

// ---------- plans, follow-ups, and "Why this plan?" ----------

export function whyThisPlan(record: CaseRecord): string {
  const decision = record.decision;
  if (!decision) return 'I have not prepared a plan yet. Tell me what happened and I will work it out with you.';
  const best = decision.options.find((option) => option.recommended);
  const used = decision.facts
    .filter((fact) => !fact.assumption && fact.unit === 'INR')
    .slice(0, 5)
    .map((fact) => `${fact.label} ${formatInr(Number(fact.value))}`)
    .join(', ');
  const alternatives = decision.options
    .filter((option) => !option.recommended)
    .slice(0, 3)
    .map((option) => {
      const blocked = option.guardrails.find((guardrail) => !guardrail.passed && guardrail.blocking);
      return `${option.title} (${option.scores.total}/100${blocked ? `, blocked: ${blocked.detail}` : ''})`;
    });
  const risks = best?.guardrails.filter((guardrail) => !guardrail.passed).map((guardrail) => guardrail.detail) ?? [];
  const parts = [
    used ? `Information used: ${used}.` : '',
    decision.calculation ? `Calculation: ${decision.calculation.formula} = ${formatInr(decision.calculation.exact_gap_inr)}.` : '',
    best ? `Recommended: ${best.title} with ${best.scores.total}/100. ${best.summary}` : 'No option passed the safety checks, so a specialist should review this.',
    alternatives.length ? `Alternatives considered: ${alternatives.join('; ')}.` : '',
    best?.trade_offs[0] ? `Trade-off: ${best.trade_offs[0]}` : '',
    risks.length ? `Risks: ${risks.join(' ')}` : '',
    'Options are scored on cost, risk, time and effort only, never on partner commission.',
  ];
  return parts.filter(Boolean).join(' ');
}

export function chatFacts(record: CaseRecord) {
  const decision = record.decision;
  return {
    event: record.event_type,
    status: record.status,
    story: redactContactIdentifiers(record.customer_message),
    known: Object.fromEntries(Object.entries(record.context?.slots ?? {}).map(([key, slot]) => [key, slot?.value ?? null])),
    calculation: decision?.calculation ?? null,
    facts: decision?.facts.map(({ label, value, unit, source }) => ({ label, value, unit, source: source.ref })) ?? [],
    options:
      decision?.options.map((option) => ({
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
    citations: (record.evidence?.retrieved_evidence ?? []).map((passage) => ({
      document: passage.document_name,
      clause: passage.clause_id,
      page: passage.page,
      title: passage.title,
    })),
    latest_timeline: record.timeline.slice(-5).map((entry) => entry.title),
  };
}

// Optional model answer, used only with the customer's AI consent and only if it repeats no number outside the facts.
async function modelAnswer(turn: Turn, facts: Record<string, unknown>): Promise<string | null> {
  if (!openaiAvailable() || !standingConsents(turn.principal.sub).ai) return null;
  try {
    const result = await answerCaseQuestion(turn.text, facts, hinglish(turn.record) ? 'Hinglish (Hindi in Latin script)' : 'English');
    if (inventedNumbers(result.answer, allowedNumbers(facts)).length) {
      recordAudit({ case_id: turn.record.case_id, actor: turn.principal.sub, event: 'ai_answer_rejected', decision: 'deny', detail: { reason: 'invented_numbers' } });
      return null;
    }
    recordAudit({ case_id: turn.record.case_id, actor: turn.principal.sub, event: 'external_ai_chat', detail: { provider: 'openai', answered_by: 'openai' } });
    return result.answer;
  } catch {
    return null;
  }
}

async function followUp(turn: Turn): Promise<void> {
  const { record, u } = turn;
  if (u.askWhy) {
    await reply(record, whyThisPlan(record), { quick_replies: [{ label: 'View full plan', action: 'open_plan' }] });
    return;
  }
  if (u.askNext) {
    const best = record.decision?.options.find((option) => option.recommended);
    await reply(
      record,
      best
        ? say(
            record,
            `Next step: open the plan and review "${best.title}". Saathi prepares the exact request, and nothing is submitted until you approve it.`,
            `Agla kadam: plan kholiye aur "${best.title}" dekhiye. Aapke approve kiye bina kuch bhi submit nahi hoga.`,
          )
        : say(record, 'A Saathi specialist is the safest next step here.', 'Yahan Saathi specialist se baat karna sabse safe hai.'),
      { quick_replies: PLAN_REPLIES },
    );
    return;
  }
  const answer = await modelAnswer(turn, chatFacts(record));
  if (answer) {
    addMessage(record, 'assistant', answer, { source: 'openai' });
    return;
  }
  await reply(
    record,
    say(
      record,
      'Your plan is ready. You can ask "Why this plan?", change any amount (for example "insurance covers 2 lakh"), or open the plan to review a step before approving it.',
      'Aapka plan taiyaar hai. Aap "Why this plan?" pooch sakte hain, koi amount badal sakte hain, ya plan khol kar step review kar sakte hain.',
    ),
    { quick_replies: PLAN_REPLIES },
  );
}

// ---------- affordability and goals ----------

function goalImpact(customerId: string, assessment: AffordabilityAssessment) {
  const goals = activeGoals(customerId);
  if (!goals.length) return null;
  const free = assessment.context.free_cash_monthly_inr;
  const needed = goals.reduce((sum, goal) => sum + (goal.required_monthly_inr ?? goal.monthly_contribution_inr ?? 0), 0);
  const recommended = assessment.scenarios.find((scenario) => scenario.id === assessment.recommended_id) ?? null;
  const emi = recommended?.monthly_emi_inr ?? 0;
  const order = { high: 0, medium: 1, low: 2 } as const;
  const focus =
    [...goals].sort((a, b) => order[a.priority] - order[b.priority] || (a.target_date ?? '9999').localeCompare(b.target_date ?? '9999')).find((goal) => goal.type !== 'emergency_fund') ??
    goals[0]!;
  const pace = focus.monthly_contribution_inr || focus.required_monthly_inr || 0;
  const delayMonths = pace > 0 ? Math.ceil((emi > 0 ? emi * (recommended?.months ?? 1) : assessment.amount_inr) / pace) : null;
  const summary =
    emi > 0
      ? `An EMI of ${formatInr(emi)} would leave about ${formatInr(Math.max(free - emi, 0))} a month after essentials and EMIs. Your active goals need about ${formatInr(needed)} a month${free - emi < needed ? `, so this would slow them down${delayMonths ? `, pushing your ${focus.name} goal back by roughly ${delayMonths} month${delayMonths === 1 ? '' : 's'}` : ''}` : ''}.`
      : `Paying ${formatInr(assessment.amount_inr)} now uses money that could go to your goals${delayMonths ? `; at your current pace it would push your ${focus.name} goal back by roughly ${delayMonths} month${delayMonths === 1 ? '' : 's'}` : ''}.`;
  return {
    summary,
    free_cash_monthly_inr: free,
    goals_monthly_need_inr: needed,
    earmarked_inr: goals.reduce((sum, goal) => sum + goal.current_savings_inr, 0),
    focus_goal: focus.name,
    delay_months: delayMonths,
  };
}

async function runAfford(turn: Turn): Promise<void> {
  const { record, ctx, principal } = turn;
  const amount = ctx.slots.purchase_inr!.value;
  const item = ctx.slots.purchase_item?.value;
  const assessment = assessAffordability(principal.sub, { amount_inr: amount, item, category: purchaseCategory(item ?? turn.text) });
  if (!assessment) {
    await reply(record, 'I could not find your account records to check this. A Saathi specialist can help.', { quick_replies: [{ label: 'Talk to a specialist', action: 'handoff' }] });
    return;
  }
  recordAudit({ case_id: record.case_id, actor: principal.sub, event: 'affordability_checked', detail: { amount_inr: amount, verdict: assessment.verdict } });
  const impact = goalImpact(principal.sub, assessment);
  ctx.awaiting = null;
  await reply(record, [assessment.headline, impact?.summary, assessment.warning].filter(Boolean).join(' '), {
    card: { type: 'afford', assessment: { ...assessment, goal_impact: impact } },
    quick_replies: [
      { label: 'View my goals', action: 'open_goals' },
      { label: 'See cash flow', action: 'open_insights' },
    ],
  });
}

async function handleAfford(turn: Turn): Promise<void> {
  const { ctx, u, text, record } = turn;
  const amount = u.amounts.find((candidate) => !['emi', 'salary', 'monthly', 'saved', 'insurance'].includes(candidate.role ?? ''));
  if (u.item) setSlot(ctx, 'purchase_item', u.item, 'customer_statement', quote(text), 1);
  if (amount) setSlot(ctx, 'purchase_inr', amount.value, 'customer_statement', quote(text), 0.95);
  if (!ctx.slots.purchase_inr) {
    ctx.awaiting = 'purchase_inr';
    await reply(record, say(record, `How much does ${ctx.slots.purchase_item ? `the ${ctx.slots.purchase_item.value}` : 'it'} cost?`, `${ctx.slots.purchase_item ? ctx.slots.purchase_item.value : 'Iski'} keemat kitni hai?`));
    return;
  }
  if (!ensureRecordsConsent(turn)) {
    await askRecordsConsent(turn, say(record, 'To check this against your balance, savings, EMIs and goals,', 'Isse aapke balance, savings, EMI aur goals ke saath check karne ke liye,'), 'afford');
    return;
  }
  await runAfford(turn);
}

const GOAL_LABELS: Record<GoalType, string> = {
  emergency_fund: 'Emergency fund',
  home: 'Home',
  vehicle: 'Car',
  education: 'Education',
  wedding: 'Wedding',
  travel: 'Travel',
  retirement: 'Retirement',
  debt_repayment: 'Debt repayment',
  custom: 'Savings goal',
};

function goalTypeOf(text: string): GoalType {
  const lower = text.toLowerCase();
  if (/emergency/.test(lower)) return 'emergency_fund';
  if (/\b(home|house|flat|apartment|down payment)\b/.test(lower)) return 'home';
  if (/\b(car|bike|scooter|scooty|vehicle|motorcycle)\b/.test(lower)) return 'vehicle';
  if (/\b(education|college|school|course|study|mba)\b/.test(lower)) return 'education';
  if (/\b(wedding|marriage|shaadi)\b/.test(lower)) return 'wedding';
  if (/\b(trip|travel|vacation|holiday)\b/.test(lower)) return 'travel';
  if (/\b(retire|retirement|pension)\b/.test(lower)) return 'retirement';
  if (/\b(loan|debt|repay|credit card)\b/.test(lower)) return 'debt_repayment';
  return 'custom';
}

async function handleGoal(turn: Turn): Promise<void> {
  const { ctx, u, text, record, principal } = turn;
  const draft: Partial<GoalDraft> = ctx.goal_draft ?? {};
  if (!draft.type || (draft.type === 'custom' && goalTypeOf(text) !== 'custom')) {
    const type = goalTypeOf(text);
    draft.type = type;
    draft.name = u.item && !['home', 'house'].includes(u.item) ? u.item.charAt(0).toUpperCase() + u.item.slice(1) : GOAL_LABELS[type];
  }
  const goalType = draft.type as GoalType;
  for (const amount of u.amounts) {
    if (amount.role === 'saved' || amount.role === 'self_pay') draft.current_savings_inr = amount.value;
    else if (amount.role === 'monthly') draft.monthly_contribution_inr = amount.value;
    else if (!draft.target_inr || ctx.awaiting === 'goal_target' || amount.role === 'target' || amount.role === 'price') draft.target_inr = amount.value;
  }
  const date = u.targetDate ?? (ctx.awaiting === 'goal_date' ? (/\b(20\d{2})\b/.exec(normalizeText(text))?.[1] ?? null) : null);
  if (date) draft.target_date = date.length === 4 ? `${date}-12-31` : date;
  ctx.goal_draft = draft;

  if (!draft.target_inr) {
    ctx.awaiting = 'goal_target';
    let hint = '';
    if (draft.type === 'emergency_fund' && ensureRecordsConsent(turn)) {
      const monthly = financialContext(principal.sub).averageExpenses;
      if (monthly) hint = ` A common guideline is 3 to 6 months of expenses; for you that is about ${formatInr(monthly * 3)} to ${formatInr(monthly * 6)}.`;
    }
    await reply(record, say(record, `How much do you want to save for your ${draft.name?.toLowerCase()} goal?${hint}`, `${draft.name} goal ke liye kitna save karna hai?${hint}`));
    return;
  }
  if (!draft.target_date) {
    ctx.awaiting = 'goal_date';
    await reply(record, say(record, 'By when would you like to reach it? For example, "December 2028".', 'Ye goal kab tak poora karna hai? Jaise "December 2028".'));
    return;
  }
  ctx.awaiting = null;
  const goal: GoalDraft = {
    name: draft.name ?? GOAL_LABELS[goalType],
    type: goalType,
    target_inr: draft.target_inr,
    target_date: draft.target_date,
    current_savings_inr: draft.current_savings_inr ?? 0,
    monthly_contribution_inr: draft.monthly_contribution_inr ?? null,
  };
  const view = computeGoal({
    ...goal,
    type: goalType,
    goal_id: 'draft',
    user_id: principal.sub,
    priority: 'medium',
    status: 'active',
    created_at: nowIso(),
    updated_at: nowIso(),
  } satisfies Goal);
  const parts = [
    `To reach ${formatInr(goal.target_inr)} by ${new Date(`${goal.target_date}T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })}${goal.current_savings_inr ? ` with ${formatInr(goal.current_savings_inr)} already saved` : ''}, you would need to set aside about ${formatInr(view.required_monthly_inr ?? view.remaining_inr)} a month${view.months_left ? ` for ${view.months_left} months` : ''}.`,
  ];
  if (ensureRecordsConsent(turn)) {
    const context = financialContext(principal.sub);
    if (context.monthlyIncome !== null && context.averageExpenses !== null) {
      const free = context.monthlyIncome - context.averageExpenses;
      const committed = activeGoals(principal.sub).reduce((sum, item) => sum + (item.required_monthly_inr ?? 0), 0);
      parts.push(
        `After your average spending you have about ${formatInr(Math.max(free, 0))} a month left${committed ? `, and your current goals already need about ${formatInr(committed)}` : ''}.`,
      );
      if ((view.required_monthly_inr ?? 0) + committed > free) parts.push('A later date or a smaller target would make this easier to reach.');
    }
  }
  if (!ctx.journey || !CASE_JOURNEYS.has(ctx.journey)) ctx.journey = 'goal';
  await reply(record, parts.join(' '), {
    card: { type: 'goal_draft', goal, required_monthly_inr: view.required_monthly_inr, months_left: view.months_left },
    quick_replies: [{ label: 'Create this goal', action: 'create_goal', payload: { ...goal } }],
  });
}

// ---------- general questions ----------

async function handleGeneral(turn: Turn): Promise<void> {
  const { record, u, principal, text, ctx } = turn;
  const lower = text.toLowerCase();
  if (u.greeting && !u.amounts.length) {
    await reply(
      record,
      say(
        record,
        `Hi ${firstName(principal)}! How can I help you today? Tell me what happened or what you want to achieve, and we'll work out the next step together.`,
        `Namaste ${firstName(principal)}! Main aapki kya madad kar sakta hoon? Bataiye kya hua ya aap kya karna chahte hain, phir hum agla kadam saath mein tay karenge.`,
      ),
    );
    return;
  }
  if (u.thanks && text.length < 40) {
    await reply(record, say(record, "You're welcome. I'm here whenever you need me.", 'Koi baat nahi. Jab bhi zaroorat ho, main yahin hoon.'));
    return;
  }
  if (u.help) {
    await reply(
      record,
      'I can help you work out what to do next when money gets complicated: plan for a hospital bill and insurance, act on a UPI payment you don\'t recognise, handle an EMI you can\'t pay on time, check if you can afford a purchase, or set and track savings goals. Tell me what happened or what you want to achieve.',
    );
    return;
  }
  if (/\b(spend|spending|spent|expenses?|kharch|kharcha|budget|monthly money|my money|money (go|going))\b/.test(lower)) {
    if (!ensureRecordsConsent(turn)) {
      await askRecordsConsent(turn, 'To look at your spending,', 'spending');
      return;
    }
    const insights = buildInsights(principal.sub);
    if (insights) {
      const top = insights.categories.slice(0, 3).map((item) => `${item.category} ${formatInr(item.amount_inr)}`).join(', ');
      const change = insights.insights.find((item) => item.id === 'spending-change');
      await reply(record, `In ${insights.period.label} you spent ${formatInr(insights.kpis.spending_inr)} against an income of ${formatInr(insights.kpis.income_inr)}. Biggest categories: ${top}.${change ? ` ${change.title}: ${change.detail}` : ''}`, {
        quick_replies: [{ label: 'Open Insights', action: 'open_insights' }],
      });
      return;
    }
  }
  if (/\b(short of cash|cash shortfall|shortfall|before (my )?salary|kam pad|run out of money)\b/.test(lower)) {
    if (!ensureRecordsConsent(turn)) {
      await askRecordsConsent(turn, 'To check what is due before your salary,', 'cashflow');
      return;
    }
    const twin = buildTwin(principal.sub, { audit: false });
    if (twin) {
      const due = twin.obligations.filter((item) => item.direction === 'out' && item.due_date < twin.before_salary.salary_date);
      await reply(
        record,
        twin.before_salary.shortfall_inr > 0
          ? `${formatInr(twin.before_salary.due_inr)} is due before your salary on ${formatDay(twin.before_salary.salary_date)} (${due.map((item) => `${item.title} ${formatInr(item.amount_inr)}`).join(', ')}), and your balance is ${formatInr(twin.before_salary.balance_inr)}, so you may be ${formatInr(twin.before_salary.shortfall_inr)} short. You could ask to move a due date, pay one bill after payday, or use savings above your safety buffer. If an EMI is involved, tell me and I'll check the lender's options.`
          : `You look covered: ${formatInr(twin.before_salary.due_inr)} is due before your salary on ${formatDay(twin.before_salary.salary_date)}, and your balance is ${formatInr(twin.before_salary.balance_inr)}.`,
        { quick_replies: [{ label: 'See cash flow', action: 'open_insights' }] },
      );
      return;
    }
  }
  if (u.amounts.length) {
    const value = u.amounts[0]!.value;
    ctx.unassigned_amount_inr = value;
    await reply(record, `What is the ${formatInr(value)} for? For example, a hospital bill, something you want to buy, or a payment you don't recognise.`, {
      quick_replies: [
        { label: "It's a hospital bill", send: `My hospital bill is ${formatInr(value)}` },
        { label: 'I want to buy something', send: `Can I afford a purchase of ${formatInr(value)}?` },
        { label: "I don't recognise a payment", send: `I don't recognize a ${formatInr(value)} UPI payment` },
      ],
    });
    return;
  }
  const answer = await modelAnswer(turn, ensureRecordsConsent(turn) ? { financial_context: financialContext(principal.sub) } : {});
  if (answer) {
    addMessage(record, 'assistant', answer, { source: 'openai' });
    return;
  }
  await reply(
    record,
    say(
      record,
      "I want to make sure I understand. I can help with hospital or medical bills, payments you don't recognise, EMIs, refunds, purchases, and savings goals. Could you tell me a little more about what happened or what you'd like to achieve?",
      'Main theek se samajhna chahta hoon. Main hospital bill, anjaan payment, EMI, refund, kharidari aur savings goals mein madad kar sakta hoon. Thoda aur bataiye kya hua?',
    ),
  );
}

// ---------- the turn ----------

function titleFor(record: CaseRecord, ctx: ConversationContext, u: Understanding, text: string): string | null {
  const journey = ctx.journey;
  if (journey && JOURNEY_TITLES[journey]) return JOURNEY_TITLES[journey]!;
  if (journey === 'afford') {
    const item = ctx.slots.purchase_item?.value;
    if (!item) return 'Purchase Planning';
    return `${/[A-Z]/.test(item) ? item : `${item.charAt(0).toUpperCase()}${item.slice(1)}`} Purchase Planning`;
  }
  if (journey === 'goal') return `${ctx.goal_draft?.name ?? 'Savings'} Goal Planning`;
  if (record.title !== NEW_CHAT_TITLE || u.greeting || u.thanks || u.help) return null;
  const words = normalizeText(text).replace(/[^\p{L}\p{N}₹\s,]/gu, '').split(' ').filter(Boolean).slice(0, 6);
  if (words.length < 2) return null;
  const title = words.join(' ');
  return title.charAt(0).toUpperCase() + title.slice(1);
}

function refreshTitle(record: CaseRecord, ctx: ConversationContext, u: Understanding, text: string): void {
  if (record.title_locked) return;
  const next = titleFor(record, ctx, u, text);
  if (next && next !== record.title) record.title = next.slice(0, 80);
}

async function suggestNewChat(turn: Turn, incoming: JourneyId): Promise<void> {
  const label = JOURNEY_TITLES[incoming]?.toLowerCase() ?? 'a different topic';
  await reply(
    turn.record,
    say(
      turn.record,
      `That sounds like a separate issue (${label}). To keep each plan accurate, I can start a new chat for it. Or we can continue with the current one.`,
      `Ye ek alag maamla lagta hai (${label}). Har plan sahi rakhne ke liye main iske liye nayi chat shuru kar sakta hoon.`,
    ),
    {
      quick_replies: [
        { label: 'Start a new chat', action: 'new_chat', payload: { message: turn.text } },
        { label: 'Continue here', send: 'Continue with my current request' },
      ],
    },
  );
}

async function offerHandoff(turn: Turn): Promise<void> {
  if (!turn.ctx.journey) turn.ctx.journey = 'specialist';
  await reply(
    turn.record,
    say(
      turn.record,
      "I can connect you with a Saathi specialist. They will see this conversation, so you won't need to repeat yourself.",
      'Main aapko Saathi specialist se jod sakta hoon. Woh ye conversation dekh payenge, aapko dobara batana nahi padega.',
    ),
    { quick_replies: [{ label: 'Connect me to a specialist', action: 'handoff' }] },
  );
}

async function continueAfterConsent(turn: Turn): Promise<void> {
  const { ctx } = turn;
  const after = ctx.after_consent;
  ctx.after_consent = null;
  if (after === 'afford' && ctx.slots.purchase_inr) return runAfford(turn);
  if (after === 'goal') return handleGoal(turn);
  if (after === 'spending') return handleGeneral({ ...turn, text: 'spending', u: understand('spending') });
  if (after === 'cashflow') return handleGeneral({ ...turn, text: 'short of cash', u: understand('short of cash') });
  if (ctx.journey === 'hospital' || ctx.journey === 'bill') return advanceHospital(turn);
  if (ctx.journey && CASE_JOURNEYS.has(ctx.journey)) return advanceRecordsJourney(turn);
  await reply(turn.record, say(turn.record, 'Thanks. What would you like me to look at?', 'Shukriya. Main kya dekhun?'));
}

async function respond(turn: Turn): Promise<void> {
  const { record, ctx, u, principal } = turn;

  if (ctx.awaiting === 'records_consent') {
    if (u.yes) {
      grantRecordsConsent(record, principal);
      ctx.awaiting = null;
      ctx.records_consent_declined = false;
      // "Yes, and insurance covers ₹3 lakh": allow access and still use what they told Saathi.
      const saidMore = u.amounts.length > 0 || u.hasInsurance !== null || u.planWithoutInsurance;
      if (!(saidMore && (ctx.journey === 'hospital' || ctx.journey === 'bill'))) return continueAfterConsent(turn);
      ctx.after_consent = null;
    }
    if (u.no) {
      ctx.awaiting = null;
      ctx.records_consent_declined = true;
      ctx.after_consent = null;
      if (ctx.journey === 'hospital') {
        await reply(record, say(record, "No problem. I won't read your records, so I'll ask you instead.", 'Koi baat nahi. Main aapke records nahi padhunga, aapse hi pooch leta hoon.'));
        absorbHospital(turn);
        return advanceHospital(turn);
      }
      await reply(
        record,
        say(
          record,
          "No problem. I won't read your records. You can allow access any time, or talk to a Saathi specialist.",
          'Koi baat nahi. Main aapke records nahi padhunga. Aap kabhi bhi permission de sakte hain.',
        ),
        { quick_replies: [{ label: 'Allow access', send: 'Yes, allow access' }, { label: 'Talk to a specialist', action: 'handoff' }] },
      );
      return;
    }
    ctx.awaiting = null;
  }
  if (u.yes && ctx.records_consent_declined && /allow/i.test(turn.text)) {
    grantRecordsConsent(record, principal);
    ctx.records_consent_declined = false;
    return continueAfterConsent(turn);
  }

  if (u.handoff) return offerHandoff(turn);

  const current = ctx.journey;
  const incoming = u.journey;
  const caseJourney = current && CASE_JOURNEYS.has(current) ? current : null;

  if (incoming && CASE_JOURNEYS.has(incoming) && caseJourney && incoming !== caseJourney) {
    const related =
      (['hospital', 'bill'].includes(caseJourney) && ['hospital', 'bill'].includes(incoming)) ||
      (['hospital', 'bill'].includes(caseJourney) && incoming === 'emi' && /\b(gap|rest|balance|bill|plan|pay)\b/i.test(turn.text)) ||
      (['hospital', 'bill'].includes(caseJourney) && incoming === 'protection' && u.amounts.length > 0);
    if (!related) return suggestNewChat(turn, incoming);
  }

  const admission = ctx.records?.admission;
  if (
    ctx.awaiting === 'bill_choice' &&
    admission &&
    caseJourney === 'hospital' &&
    (u.amounts.length || u.yes || u.no || /\b(hospital|use|plan|mine|my|mera|meri)\b/i.test(turn.text))
  ) {
    const amount = u.amounts[0]?.value ?? null;
    ctx.awaiting = null;
    if (/hospital/i.test(turn.text) || amount === admission.total_inr || (u.yes && !amount)) {
      ctx.hospital_bill_declined = false;
      useAdmissionBill(turn);
    } else {
      ctx.hospital_bill_declined = true;
      if (amount) setSlot(ctx, 'bill_inr', amount, 'customer_statement', quote(turn.text), 0.9);
    }
    return advanceHospital(turn, { updated: Boolean(record.decision) });
  }

  if (/^continue with my current request$/i.test(turn.text.trim())) {
    if (caseJourney === 'hospital' || caseJourney === 'bill') return advanceHospital(turn);
    if (caseJourney) return advanceRecordsJourney(turn);
  }

  // Answers to an open question go to the journey that asked it.
  if (ctx.awaiting === 'purchase_inr') return handleAfford(turn);
  if (ctx.awaiting === 'goal_target' || ctx.awaiting === 'goal_date') return handleGoal(turn);

  if (incoming === 'afford' && !(caseJourney && ['hospital', 'bill'].includes(caseJourney) && ctx.awaiting)) {
    if (!caseJourney) ctx.journey = 'afford';
    delete ctx.slots.purchase_inr;
    delete ctx.slots.purchase_item;
    return handleAfford(turn);
  }
  if (incoming === 'goal' && !caseJourney) {
    ctx.journey = 'goal';
    ctx.goal_draft = null;
    return handleGoal(turn);
  }

  if (caseJourney === 'hospital' || caseJourney === 'bill' || (!caseJourney && (incoming === 'hospital' || incoming === 'bill'))) {
    if (!caseJourney) setJourney(turn, incoming!);
    if (ctx.journey === 'hospital') setJourney(turn, 'hospital');
    const { changed, ambiguous } = absorbHospital(turn);
    if (ctx.journey === 'hospital') setJourney(turn, 'hospital');
    if (ctx.journey === 'bill' && (turn.u.otherBill || (ctx.awaiting === 'bill_kind' && u.no))) {
      const bill = ctx.slots.bill_inr?.value;
      ctx.journey = 'afford';
      ctx.awaiting = null;
      if (bill) setSlot(ctx, 'purchase_inr', bill, 'customer_statement', quote(turn.text), 0.95);
      setSlot(ctx, 'purchase_item', 'this bill', 'customer_statement', quote(turn.text), 1);
      return handleAfford({ ...turn, u: { ...u, amounts: [] } });
    }
    if (ambiguous !== null) {
      ctx.unassigned_amount_inr = ambiguous;
      ctx.awaiting = 'amount_role';
      await reply(record, `Is ${formatInr(ambiguous)} the bill amount, the insurance cover, or what you can pay now?`, {
        quick_replies: [
          { label: "It's the bill", send: `The bill is ${formatInr(ambiguous)}` },
          { label: 'Insurance covers it', send: `Insurance covers ${formatInr(ambiguous)}` },
          { label: 'I can pay this', send: `I can pay ${formatInr(ambiguous)}` },
        ],
      });
      return;
    }
    if (record.decision && !changed && !u.amounts.length && u.hasInsurance === null && !u.planWithoutInsurance) return followUp(turn);
    return advanceHospital(turn, { updated: Boolean(record.decision && (changed || u.amounts.length > 0)) });
  }

  if (caseJourney || (incoming && CASE_JOURNEYS.has(incoming))) {
    if (!caseJourney) setJourney(turn, incoming!);
    absorbRecordsJourney(turn);
    return advanceRecordsJourney(turn);
  }

  if (incoming === 'specialist') return offerHandoff(turn);
  return handleGeneral(turn);
}

export async function handleTurn(
  principal: Principal,
  input: { conversation_id?: string; message: string; language?: string },
): Promise<CaseRecord> {
  const record = input.conversation_id
    ? loadCaseForOwner(principal, input.conversation_id, 'case:create')
    : createConversation(principal, input.language);
  if (input.language) {
    if (input.language === 'en-IN') delete record.preferred_language;
    else record.preferred_language = input.language;
  }
  const text = input.message.trim();
  const isFirst = !record.messages.some((message) => message.role === 'user');
  addMessage(record, 'user', text);
  record.customer_message = record.customer_message ? `${record.customer_message}\n${text}` : text;
  const u = understand(text);
  if (isFirst || u.language === 'hinglish') record.language = u.language;
  const ctx = (record.context ??= emptyContext());
  const turn: Turn = { record, principal, ctx, u, text };
  if (isFirst) addTimeline(record, { title: 'Conversation started', detail: 'Saathi is working from what you share here.', actor: 'customer' });
  try {
    await respond(turn);
  } catch (error) {
    addMessage(record, 'assistant', GENERIC_ERROR);
    recordAudit({
      case_id: record.case_id,
      actor: principal.sub,
      event: 'turn_failed',
      detail: { reason: error instanceof Error ? error.message.slice(0, 200) : 'unknown' },
    });
  }
  ctx.updated_at = nowIso();
  refreshTitle(record, ctx, u, text);
  recordAudit({ case_id: record.case_id, actor: principal.sub, event: 'chat_turn', detail: { journey: ctx.journey, awaiting: ctx.awaiting } });
  updateCase(record);
  return record;
}

// Consent granted from the plan panel rather than in chat: pick up where the conversation was waiting.
export async function resumeAfterConsent(principal: Principal, record: CaseRecord): Promise<void> {
  const ctx = record.context;
  if (!ctx || ctx.awaiting !== 'records_consent') return;
  ctx.awaiting = null;
  ctx.records_consent_declined = false;
  await continueAfterConsent({ record, principal, ctx, u: understand(''), text: '' });
}

export { decorateAfterRun };

// Called after the customer confirms an uploaded bill: the confirmed total replaces what they said, then the plan continues.
export async function continueAfterBillConfirmed(principal: Principal, record: CaseRecord): Promise<void> {
  const ctx = (record.context ??= emptyContext());
  const stated = ctx.slots.bill_inr;
  if (stated?.source === 'customer_statement') ctx.stated_bill_inr = stated.value;
  if (record.confirmed_bill) {
    setSlot(ctx, 'bill_inr', record.confirmed_bill.total_inr, 'uploaded_document', record.confirmed_bill.document_name, 0.95);
  }
  if (!ctx.journey || ctx.journey === 'bill' || ctx.journey === 'general') ctx.journey = 'hospital';
  const turn: Turn = { record, principal, ctx, u: understand(''), text: '' };
  setJourney(turn, 'hospital');
  await advanceHospital(turn, { updated: Boolean(record.decision) });
}

// What Saathi says after a document is uploaded. It reads what it can and asks the customer to confirm the rest.
export async function afterDocumentUpload(
  _principal: Principal,
  record: CaseRecord,
  document: UploadedDocument,
  parsedBill: { total_inr: number; reconciled: boolean } | null,
): Promise<'confirm_bill' | 'redecide' | 'none'> {
  const ctx = (record.context ??= emptyContext());
  if (parsedBill) {
    if (!ctx.journey || ctx.journey === 'general') ctx.journey = 'hospital';
    await reply(
      record,
      `I read ${formatInr(parsedBill.total_inr)} as the total of ${document.document_name}${parsedBill.reconciled ? ' (the line items add up)' : ''}. Is that right? Once you confirm, I'll use it for your plan.`,
      { card: { type: 'bill_confirmation' } },
    );
    return 'confirm_bill';
  }
  if (document.document_type === 'bill') {
    await reply(
      record,
      `I added ${document.document_name}, but I couldn't confidently read the bill total from it. Please tell me the total amount on the bill.`,
    );
    ctx.awaiting = 'bill_inr';
    return record.decision ? 'redecide' : 'none';
  }
  const sumInsured = /sum\s+insured[^0-9₹]{0,30}(?:₹|rs\.?|inr)?\s*([0-9][0-9,]*(?:\.\d+)?\s*(?:lakhs?|lacs?|crores?)?)/i.exec(document.text);
  const page = sumInsured ? (document.text.slice(0, sumInsured.index).match(/\[Page (\d+)\]/g)?.at(-1)?.match(/\d+/)?.[0] ?? '1') : null;
  const parsed = sumInsured ? parseAmounts(`₹${sumInsured[1]}`)[0]?.value ?? null : null;
  if (parsed) setSlot(ctx, 'policy_sum_insured_inr', parsed, 'uploaded_document', `${document.document_name}, page ${page}`, 0.7);
  if (ctx.slots.has_insurance?.value !== true) setSlot(ctx, 'has_insurance', true, 'uploaded_document', document.document_name, 0.9);
  if (!ctx.journey || ctx.journey === 'general' || ctx.journey === 'bill') ctx.journey = 'hospital';
  await reply(
    record,
    `${parsed ? `Your policy (${document.document_name}, page ${page}) mentions a sum insured of ${formatInr(parsed)}. That is the most the policy can pay in a year, not what this claim will pay. ` : ''}I couldn't confidently determine your coverage for this bill from the policy. Please confirm the expected coverage. The hospital's insurance (TPA) desk can tell you the pre-authorised amount.`,
    {
      quick_replies: [
        { label: "I'm not sure", send: "I don't know how much insurance will cover" },
        { label: 'Plan without insurance for now', send: 'Plan without insurance for now' },
      ],
    },
  );
  ctx.awaiting = 'insurance_cover_inr';
  return record.decision ? 'redecide' : 'none';
}
