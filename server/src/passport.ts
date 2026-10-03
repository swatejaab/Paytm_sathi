import { redactContactIdentifiers } from './redaction';
import type { CaseRecord, ResolutionPassport } from './types';

export function buildPassport(record: CaseRecord): ResolutionPassport {
  const decision = record.decision;
  const recommended = decision?.options.find((option) => option.option_id === decision.recommended_option_id);
  return {
    passport_id: `RP-${record.case_id}`,
    case_id: record.case_id,
    customer_id: record.customer_id,
    event: { type: record.event_type, urgency: record.urgency },
    story: redactContactIdentifiers(record.customer_message),
    facts: decision?.facts ?? [],
    calculation: decision?.calculation ?? null,
    evidence_sources: (record.evidence?.retrieved_evidence ?? []).map((passage) => ({
      document_name: passage.document_name,
      clause_id: passage.clause_id,
      page: passage.page,
      title: passage.title,
    })),
    documents: [
      ...(record.evidence?.documents ?? []).map((document) => ({
        document_name: document.document_name,
        document_type: document.document_type,
        origin: 'synthetic_fixture' as const,
      })),
      ...record.uploaded_documents.map((document) => ({
        document_name: document.document_name,
        document_type: document.document_type,
        origin: 'customer_upload' as const,
      })),
    ],
    missing_documents: record.evidence?.missing_documents ?? [],
    transaction: record.evidence?.transaction ?? null,
    recommended_option: recommended?.title ?? null,
    consents: record.consents,
    notice:
      'Saathi prepares and coordinates; insurers decide claims and regulated lenders decide credit.',
  };
}
