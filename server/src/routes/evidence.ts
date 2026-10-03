import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { getPrincipal, requireAuth } from '../auth';
import { addTimeline, loadCaseForOwner, loadCaseForRead, newId } from '../caseStore';
import { settings } from '../config';
import { nowIso, recordAudit, updateCase } from '../db';
import {
  DocumentError,
  extractDocumentText,
  normalizeContentType,
  retrieveUploadedPassages,
  safeFilename,
  uploadedEvidenceQuery,
} from '../documents';
import { HttpError, parseBody } from '../errors';
import {
  allowedNumbers,
  analyzeCaseWithOpenAI,
  answerCaseQuestion,
  inventedNumbers,
  IntegrationDisabledError,
  ocrImageWithOpenAI,
  IntegrationInputError,
  IntegrationRequestError,
  speakWithSarvam,
  transcribeWithSarvam,
  type AnalysisEvidence,
} from '../integrations';
import type { CaseRecord, UploadedDocument } from '../types';
import { explainDecision } from '../agent/explainer';
import { addMessage } from '../caseStore';
import { isLanguageCode, LANGUAGE_CODES, LANGUAGES } from '../languages';
import { redactContactIdentifiers } from '../redaction';
import { redecideAfterDocuments } from '../workflow';

export const evidenceRouter = Router();

const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: settings.maxDocumentBytes, files: 1, fields: 4 },
}).single('file');
const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: settings.maxAudioBytes, files: 1, fields: 4 },
}).single('file');

const MAX_DOCUMENTS_PER_CASE = 4;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_CASE_TEXT = 200_000;

function uploadedEvidence(record: CaseRecord) {
  const policies = record.uploaded_documents.filter((document) => document.document_type === 'policy');
  return retrieveUploadedPassages(uploadedEvidenceQuery(record.customer_message), policies);
}

function mapIntegrationError(error: unknown): never {
  if (error instanceof IntegrationDisabledError) throw new HttpError(503, error.message);
  if (error instanceof IntegrationInputError) throw new HttpError(422, error.message);
  if (error instanceof IntegrationRequestError) throw new HttpError(502, error.message);
  throw error;
}

evidenceRouter.get('/cases/:caseId/evidence', requireAuth('case:read', 'case:read:any'), (req, res) => {
  const record = loadCaseForRead(getPrincipal(req), String(req.params.caseId));
  const uploads = record.uploaded_documents;
  const evidence = record.evidence;
  if (uploads.length) {
    res.json({
      case_id: record.case_id,
      demo_only: false,
      documents: uploads,
      retrieved_evidence: uploadedEvidence(record),
      missing_documents: [],
      calculation: null,
      transaction: null,
      playbook: null,
      notice:
        'Uploaded-document text is shown for review. Coverage was not derived from these uploads, so automated steps wait for a specialist.',
    });
    return;
  }
  if (!evidence) {
    res.json({
      case_id: record.case_id,
      demo_only: false,
      documents: [],
      retrieved_evidence: [],
      missing_documents: [],
      calculation: null,
      transaction: null,
      playbook: null,
      notice: 'No documents or evidence are attached to this case yet.',
    });
    return;
  }
  res.json({
    case_id: record.case_id,
    demo_only: evidence.demo_only,
    documents: evidence.documents,
    retrieved_evidence: evidence.retrieved_evidence,
    missing_documents: evidence.missing_documents,
    calculation: record.decision?.calculation ?? null,
    transaction: evidence.transaction ?? null,
    playbook: evidence.playbook ?? null,
    notice: evidence.notice,
  });
});

evidenceRouter.post('/cases/:caseId/documents', requireAuth('document:upload'), documentUpload, async (req, res) => {
  const principal = getPrincipal(req);
  const caseId = String(req.params.caseId);
  loadCaseForOwner(principal, caseId, 'document:upload');
  const documentType = z.enum(['bill', 'policy']).safeParse(req.body?.document_type);
  if (!documentType.success) throw new HttpError(422, 'document_type must be "bill" or "policy".');
  if (!req.file) throw new HttpError(422, 'Attach a file in the "file" field.');

  const filename = safeFilename(req.file.originalname, 'uploaded-document');
  const contentType = normalizeContentType(req.file.mimetype);
  let extracted: { text: string; pageCount: number };
  let viaOcr = false;
  if (IMAGE_TYPES.has(contentType)) {
    const ocrConsent = ['true', '1', 'yes', 'on'].includes(String(req.body?.ocr_consent ?? '').toLowerCase());
    if (!ocrConsent) throw new HttpError(403, 'Consent is required before sending a photo to OpenAI for text extraction.');
    try {
      const text = redactContactIdentifiers(await ocrImageWithOpenAI(req.file.buffer, contentType));
      extracted = { text: `[Page 1]\n${text}`, pageCount: 1 };
      viaOcr = true;
    } catch (error) {
      mapIntegrationError(error);
    }
  } else {
    try {
      extracted = await extractDocumentText(filename, contentType, req.file.buffer);
    } catch (error) {
      if (error instanceof DocumentError) throw new HttpError(422, error.message);
      throw error;
    }
  }

  const record = loadCaseForOwner(principal, caseId, 'document:upload');
  if (record.status === 'in_progress' || record.status === 'resolved') {
    throw new HttpError(409, 'Documents cannot be added after partner steps have started.');
  }
  if (record.uploaded_documents.length >= MAX_DOCUMENTS_PER_CASE) {
    throw new HttpError(422, 'A case may contain at most four uploaded documents.');
  }
  const existingCharacters = record.uploaded_documents.reduce((sum, document) => sum + document.text.length, 0);
  if (existingCharacters + extracted.text.length > MAX_CASE_TEXT) {
    throw new HttpError(422, 'Combined extracted text exceeds the 200,000 character case limit.');
  }

  const document: UploadedDocument = {
    document_id: newId('DOC', 10),
    document_type: documentType.data,
    document_name: filename,
    content_type: contentType,
    page_count: extracted.pageCount,
    text: extracted.text,
    uploaded_at: nowIso(),
  };
  record.uploaded_documents.push(document);
  addTimeline(record, {
    title: `Document added: ${filename}`,
    detail: `${documentType.data}, ${extracted.pageCount} page(s)${viaOcr ? ', read from a photo with OpenAI OCR' : ''}. Contact identifiers redacted; the original file was not stored.`,
    actor: 'customer',
  });
  recordAudit({
    case_id: record.case_id,
    actor: principal.sub,
    event: 'document_uploaded',
    detail: { document_id: document.document_id, document_type: document.document_type, characters: extracted.text.length, ocr: viaOcr },
  });

  await redecideAfterDocuments(principal, record);
  updateCase(record);

  res.status(201).json({
    document_id: document.document_id,
    document_name: filename,
    document_type: document.document_type,
    page_count: extracted.pageCount,
    extracted_characters: extracted.text.length,
    message: 'Text extracted and contact identifiers redacted. The original file was not stored.',
  });
});

const analysisConsentSchema = z.object({ confirm_external_processing: z.boolean().default(false) }).strict();

evidenceRouter.post('/cases/:caseId/analyze', requireAuth('ai:analyze'), async (req, res) => {
  const principal = getPrincipal(req);
  const caseId = String(req.params.caseId);
  const consent = parseBody(analysisConsentSchema, req.body);
  const record = loadCaseForOwner(principal, caseId, 'ai:analyze');
  if (!consent.confirm_external_processing) {
    throw new HttpError(403, 'Explicit consent is required before sending redacted case text to OpenAI.');
  }

  const evidence: AnalysisEvidence = record.uploaded_documents.length
    ? {
        event_type: record.event_type,
        documents: record.uploaded_documents,
        retrieved_evidence: uploadedEvidence(record),
        missing_documents: [],
      }
    : {
        event_type: record.event_type,
        documents: record.evidence?.documents ?? [],
        retrieved_evidence: record.evidence?.retrieved_evidence ?? [],
        missing_documents: record.evidence?.missing_documents ?? [],
      };

  let analysis: Awaited<ReturnType<typeof analyzeCaseWithOpenAI>>;
  try {
    analysis = await analyzeCaseWithOpenAI(record.customer_message, evidence);
  } catch (error) {
    mapIntegrationError(error);
  }

  const latest = loadCaseForOwner(principal, caseId, 'ai:analyze');
  latest.ai_analysis = {
    ...analysis,
    created_at: nowIso(),
    consent_purpose: 'analyze_redacted_case_text_with_openai',
  };
  recordAudit({
    case_id: caseId,
    actor: principal.sub,
    event: 'external_ai_analysis',
    detail: { provider: 'openai', model: analysis.model, consent_purpose: 'analyze_redacted_case_text_with_openai' },
  });
  updateCase(latest);
  res.json({ case_id: caseId, analysis: latest.ai_analysis });
});

evidenceRouter.post('/voice/transcribe', requireAuth('voice:transcribe'), audioUpload, async (req, res) => {
  const principal = getPrincipal(req);
  const consent = String(req.body?.consent_to_transcribe ?? '').toLowerCase();
  if (!['true', '1', 'yes', 'on'].includes(consent)) {
    throw new HttpError(403, 'Consent is required before sending audio to Sarvam.');
  }
  if (!req.file) throw new HttpError(422, 'Attach an audio recording in the "file" field.');
  try {
    const requested = String(req.body?.language_code ?? '');
    const result = await transcribeWithSarvam(
      req.file.buffer,
      safeFilename(req.file.originalname, 'voice-note.wav'),
      normalizeContentType(req.file.mimetype),
      isLanguageCode(requested) ? requested : 'unknown',
    );
    recordAudit({ actor: principal.sub, event: 'voice_transcription', detail: { provider: 'sarvam', consent: true } });
    res.json(result);
  } catch (error) {
    mapIntegrationError(error);
  }
});

const speakSchema = z
  .object({ text: z.string().trim().min(1).max(1500), language_code: z.enum(LANGUAGE_CODES), consent: z.literal(true) })
  .strict();

evidenceRouter.post('/voice/speak', requireAuth('voice:transcribe'), async (req, res) => {
  const principal = getPrincipal(req);
  const body = parseBody(speakSchema, req.body);
  try {
    const result = await speakWithSarvam(redactContactIdentifiers(body.text), body.language_code);
    recordAudit({ actor: principal.sub, event: 'voice_synthesis', detail: { provider: 'sarvam', language: body.language_code } });
    res.json(result);
  } catch (error) {
    mapIntegrationError(error);
  }
});

const chatSchema = z
  .object({
    message: z.string().trim().min(2).max(1000),
    language: z.enum(LANGUAGE_CODES).optional(),
    confirm_external_processing: z.literal(true),
  })
  .strict();

// Facts the assistant may use: the deterministic decision, evidence citations, and the case status. No raw documents.
function chatFacts(record: CaseRecord) {
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

evidenceRouter.post('/cases/:caseId/chat', requireAuth('ai:analyze'), async (req, res) => {
  const principal = getPrincipal(req);
  const caseId = String(req.params.caseId);
  const body = parseBody(chatSchema, req.body);
  const record = loadCaseForOwner(principal, caseId, 'ai:analyze');
  const languageCode = body.language ?? record.preferred_language;
  const languageName = isLanguageCode(languageCode)
    ? LANGUAGES[languageCode]
    : record.language === 'hinglish'
      ? 'Hinglish (Hindi in Latin script)'
      : 'English';
  const facts = chatFacts(record);

  let answer: string;
  let source: 'openai' | 'saathi' = 'openai';
  try {
    const result = await answerCaseQuestion(body.message, facts, languageName);
    const invented = inventedNumbers(result.answer, allowedNumbers(facts));
    if (invented.length) {
      // Numeric guard: the model may only repeat numbers the decision service produced.
      source = 'saathi';
      answer = explainDecision(record) || 'I can only answer from your case facts. A Saathi specialist can help with this question.';
      recordAudit({ case_id: caseId, actor: principal.sub, event: 'ai_answer_rejected', decision: 'deny', detail: { reason: 'invented_numbers', count: invented.length } });
    } else {
      answer = result.answer;
    }
  } catch (error) {
    mapIntegrationError(error);
  }

  const latest = loadCaseForOwner(principal, caseId, 'ai:analyze');
  addMessage(latest, 'user', body.message);
  addMessage(latest, 'assistant', answer, { source, ...(isLanguageCode(languageCode) ? { language: languageCode } : {}) });
  recordAudit({
    case_id: caseId,
    actor: principal.sub,
    event: 'external_ai_chat',
    detail: { provider: 'openai', consent_purpose: 'answer_case_question_with_openai', answered_by: source },
  });
  updateCase(latest);
  res.json(latest);
});
