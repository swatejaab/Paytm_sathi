import { extractText, getDocumentProxy } from 'unpdf';
import { healthRecordsFor } from './fixtures';
import { redactContactIdentifiers } from './redaction';
import type { EvidencePassage, UploadedDocument } from './types';

export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
export const MAX_DOCUMENT_PAGES = 20;
export const MAX_EXTRACTED_CHARACTERS = 100_000;

export class DocumentError extends Error {}

const PDF_TYPES = new Set(['application/pdf', 'application/octet-stream']);
const TEXT_TYPES = new Set(['text/plain', 'application/json', 'application/octet-stream']);

export function normalizeContentType(contentType: string | undefined): string {
  return (contentType || 'application/octet-stream').split(';')[0]!.trim().toLowerCase();
}

export function safeFilename(name: string | undefined, fallback: string): string {
  const base = (name || '').split(/[\\/]/).pop() || '';
  return (base || fallback).slice(0, 120);
}

async function extractPdfPages(content: Buffer): Promise<string[]> {
  try {
    const pdf = await getDocumentProxy(new Uint8Array(content));
    if (pdf.numPages > MAX_DOCUMENT_PAGES) {
      throw new DocumentError('Documents may contain at most 20 pages.');
    }
    const { text } = await extractText(pdf, { mergePages: false });
    return text;
  } catch (error) {
    if (error instanceof DocumentError) throw error;
    if ((error as { name?: string } | null)?.name === 'PasswordException') {
      throw new DocumentError('Password-protected PDFs are not supported.');
    }
    throw new DocumentError('The uploaded PDF could not be read.');
  }
}

export async function extractDocumentText(
  filename: string,
  contentType: string,
  content: Buffer,
): Promise<{ text: string; pageCount: number }> {
  if (!content.length) throw new DocumentError('The uploaded document is empty.');
  if (content.length > MAX_DOCUMENT_BYTES) throw new DocumentError('Each document must be 5 MB or smaller.');

  const suffix = filename.includes('.') ? filename.slice(filename.lastIndexOf('.')).toLowerCase() : '';
  let extracted: string;
  let pageCount: number;

  if (suffix === '.pdf' && PDF_TYPES.has(contentType)) {
    if (content.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new DocumentError('The uploaded file is not a valid PDF.');
    }
    const pages = await extractPdfPages(content);
    if (!pages.join('').trim()) {
      throw new DocumentError('This PDF has no selectable text. Upload a JPG or PNG photo of each page instead to use photo OCR.');
    }
    extracted = pages.map((text, index) => `[Page ${index + 1}]\n${text}`).join('\n\n');
    pageCount = pages.length;
  } else if ((suffix === '.txt' || suffix === '.json') && TEXT_TYPES.has(contentType)) {
    try {
      let decoded = new TextDecoder('utf-8', { fatal: true }).decode(content).replace(/^\uFEFF/, '');
      if (suffix === '.json') decoded = JSON.stringify(JSON.parse(decoded), null, 2);
      extracted = decoded;
    } catch {
      throw new DocumentError('Upload valid UTF-8 text or JSON.');
    }
    pageCount = 1;
  } else {
    throw new DocumentError('Supported documents are text-based PDF, TXT, or JSON files.');
  }

  if (extracted.length > MAX_EXTRACTED_CHARACTERS) {
    throw new DocumentError('Extracted document text exceeds the 100,000 character limit.');
  }
  return { text: redactContactIdentifiers(extracted), pageCount };
}

function terms(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

function overlap(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const term of a) if (b.has(term)) count += 1;
  return count;
}

export function retrievePolicyClauses(customerId: string, query: string, topK = 3): EvidencePassage[] {
  const { policy } = healthRecordsFor(customerId);
  if (!policy) return [];
  const queryTerms = terms(query);
  return policy.clauses
    .map((clause, index) => ({ clause, index, score: overlap(queryTerms, terms(`${clause.title} ${clause.text}`)) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, topK)
    .map(({ clause, score }) => ({
      document_id: policy.document_id,
      document_name: policy.file_name,
      document_type: 'policy',
      clause_id: clause.clause_id,
      page: clause.page,
      title: clause.title,
      text: clause.text,
      estimated_coverage_inr: clause.estimated_coverage_inr,
      score,
    }));
}

export function retrieveUploadedPassages(
  query: string,
  documents: UploadedDocument[],
  topK = 4,
): EvidencePassage[] {
  const queryTerms = terms(query);
  const ranked: { score: number; documentIndex: number; chunkIndex: number; passage: Omit<EvidencePassage, 'score'> }[] = [];

  documents.forEach((document, documentIndex) => {
    String(document.text ?? '')
      .split(/(?=\[Page \d+\])/)
      .forEach((chunk, chunkIndex) => {
        const cleaned = chunk.trim();
        if (!cleaned) return;
        const pageMatch = /^\[Page (\d+)\]/.exec(cleaned);
        const page = pageMatch ? Number(pageMatch[1]) : chunkIndex + 1;
        const body = cleaned.replace(/^\[Page \d+\]\s*/, '').trim();
        const score = overlap(queryTerms, terms(body));
        if (score) {
          ranked.push({
            score,
            documentIndex,
            chunkIndex,
            passage: {
              document_id: document.document_id,
              document_name: document.document_name,
              document_type: document.document_type,
              page,
              text: body.slice(0, 3000),
            },
          });
        }
      });
  });

  ranked.sort((a, b) => b.score - a.score || a.documentIndex - b.documentIndex || a.chunkIndex - b.chunkIndex);
  return ranked.slice(0, Math.max(0, Math.min(topK, 5))).map(({ passage, score }) => ({ ...passage, score }));
}

export function uploadedEvidenceQuery(customerMessage: string): string {
  return `${customerMessage} insurance policy coverage hospital inpatient claim documents`;
}