import { useEffect, useState } from 'react';
import { api, errorMessage } from '../api';
import { factValue, sourceLabel, sourceTypeLabel } from '../format';
import type { CaseRecord, EvidencePassage, EvidenceResponse, IntegrationStatus } from '../types';
import { hasActiveConsent } from './CasePanel';
import { LOW_CONFIDENCE } from './WhyPlan';

type Run = (operation: () => Promise<CaseRecord>) => Promise<void>;

interface Props {
  caseRecord: CaseRecord;
  integrations: IntegrationStatus;
  readOnly: boolean;
  busy: boolean;
  run: Run;
}

function Confidence({ value }: { value: number }) {
  const level = value >= 0.9 ? 'high' : value >= LOW_CONFIDENCE ? 'medium' : 'low';
  return (
    <span className={`confidence confidence-${level}`} title="How sure Saathi is about this value">
      {level === 'high' ? 'High' : level === 'medium' ? 'Medium' : 'Low'}
    </span>
  );
}

function citation(passage: EvidencePassage): string {
  const where = passage.clause_id ? `Section ${passage.clause_id}` : `Page ${passage.page}`;
  return `${passage.document_name} · ${where}`;
}

export function EvidenceView({ caseRecord, integrations, readOnly, busy, run }: Props) {
  const [evidence, setEvidence] = useState<EvidenceResponse | null>(null);
  const [policyFiles, setPolicyFiles] = useState<File[]>([]);
  const [billFiles, setBillFiles] = useState<File[]>([]);
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);
  const [aiConsent, setAiConsent] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .evidence(caseRecord.case_id)
      .then((result) => !cancelled && setEvidence(result))
      .catch(() => !cancelled && setEvidence(null));
    return () => {
      cancelled = true;
    };
  }, [caseRecord.case_id, caseRecord.updated_at]);

  const facts = caseRecord.decision?.facts ?? [];
  const consented = hasActiveConsent(caseRecord);
  const canUpload = !readOnly && !['in_progress', 'resolved'].includes(caseRecord.status);

  const [ocrConsent, setOcrConsent] = useState(false);
  const hasPhotos = [...policyFiles, ...billFiles].some((file) => file.type.startsWith('image/'));

  const upload = async () => {
    setUploadMessage(null);
    await run(async () => {
      for (const file of policyFiles) await api.uploadDocument(caseRecord.case_id, 'policy', file, ocrConsent);
      for (const file of billFiles) await api.uploadDocument(caseRecord.case_id, 'bill', file, ocrConsent);
      setPolicyFiles([]);
      setBillFiles([]);
      setUploadMessage('Text extracted and contact identifiers redacted. Original files were not retained.');
      return api.getCase(caseRecord.case_id);
    });
  };

  const analyze = async () => {
    setAiBusy(true);
    setAiError(null);
    try {
      await api.analyze(caseRecord.case_id);
      await run(() => api.getCase(caseRecord.case_id));
    } catch (caught) {
      setAiError(errorMessage(caught));
    } finally {
      setAiBusy(false);
    }
  };

  return (
    <div className="evidence">
      {evidence && <p className="muted small">{evidence.notice}</p>}

      {facts.length > 0 && (
        <section>
          <h3>Facts behind the plan</h3>
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Fact</th>
                  <th>Value</th>
                  <th>Source</th>
                  <th>Confidence</th>
                </tr>
              </thead>
              <tbody>
                {facts.map((fact, index) => (
                  <tr key={`${fact.name}-${index}`} className={fact.assumption ? 'assumption' : ''}>
                    <td>
                      {fact.label}
                      {fact.assumption && <span className="badge badge-amber">Assumption</span>}
                      {fact.confirmed_by_customer && <span className="badge badge-green">You confirmed</span>}
                      {fact.confidence < LOW_CONFIDENCE && (
                        <small className="low-confidence">
                          I couldn't confidently determine this from your {fact.source.type === 'policy_clause' ? 'policy' : 'documents'}. Please
                          confirm it before relying on the plan.
                        </small>
                      )}
                    </td>
                    <td>
                      <strong>{factValue(fact)}</strong>
                    </td>
                    <td className="source">
                      <span className="source-type">{sourceTypeLabel(fact.source.type)}</span>
                      {sourceLabel(fact.source)}
                    </td>
                    <td>
                      <Confidence value={fact.confidence} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {evidence && evidence.retrieved_evidence.length > 0 && (
        <section>
          <h3>Sources</h3>
          {evidence.retrieved_evidence.map((passage) => (
            <details key={`${passage.document_id}-${passage.clause_id ?? passage.page}`} className="citation">
              <summary>
                <strong>{citation(passage)}</strong>
                {passage.title && <small>{passage.title}</small>}
              </summary>
              <p>{passage.text}</p>
              <small className="muted">Page {passage.page}</small>
            </details>
          ))}
        </section>
      )}

      {evidence && evidence.missing_documents.length > 0 && (
        <p className="alert alert-warn">Still needed for the claim: {evidence.missing_documents.join(', ')}</p>
      )}

      {caseRecord.uploaded_documents.length > 0 && (
        <section>
          <h3>Your uploads</h3>
          {caseRecord.uploaded_documents.map((document) => (
            <details key={document.document_id} className="upload-preview">
              <summary>
                {document.document_name} / {document.document_type} / {document.page_count} page(s)
              </summary>
              <pre>{document.text.slice(0, 1500)}</pre>
            </details>
          ))}
        </section>
      )}

      {canUpload && (
        <details className="card-inset">
          <summary>Add a bill or policy</summary>
          <p className="muted small">
            PDF, text file, or a photo of a page. Up to 5 MB each and four per conversation. Saathi keeps only the extracted text, with
            contact details removed.
          </p>
          <div className="upload-grid">
            <label className="field">
              <span>Health policy documents</span>
              <input type="file" accept=".pdf,.txt,.json,.jpg,.jpeg,.png,.webp" multiple onChange={(event) => setPolicyFiles([...(event.target.files ?? [])])} />
            </label>
            <label className="field">
              <span>Hospital bill documents</span>
              <input type="file" accept=".pdf,.txt,.json,.jpg,.jpeg,.png,.webp" multiple onChange={(event) => setBillFiles([...(event.target.files ?? [])])} />
            </label>
          </div>
          {hasPhotos && (
            <label className="checkbox">
              <input type="checkbox" checked={ocrConsent} onChange={(event) => setOcrConsent(event.target.checked)} />
              {integrations.openai_available
                ? 'Allow Saathi to read the text in my photos with an AI service. Only the extracted text is kept, with contact details removed.'
                : "Photos can't be read right now. Please upload a PDF or text file instead."}
            </label>
          )}
          <button
            className="btn"
            disabled={busy || (!policyFiles.length && !billFiles.length) || (hasPhotos && (!ocrConsent || !integrations.openai_available))}
            onClick={upload}
          >
            Upload and extract text
          </button>
          {uploadMessage && <p className="muted small">{uploadMessage}</p>}
        </details>
      )}

      {integrations.openai_available && !readOnly && (
        <details className="card-inset">
          <summary>Get an AI summary of your documents</summary>
          <label className="checkbox">
            <input type="checkbox" checked={aiConsent} onChange={(event) => setAiConsent(event.target.checked)} />I agree to send the
            redacted conversation text and documents to an AI service for this summary.
          </label>
          <button className="btn" disabled={!aiConsent || aiBusy} onClick={analyze}>
            {aiBusy ? 'Reading your documents...' : 'Summarize'}
          </button>
          {aiError && <p className="alert alert-error">{aiError}</p>}
        </details>
      )}

      {caseRecord.ai_analysis && (
        <section className="card-inset">
          <h3>AI evidence summary</h3>
          <p>{caseRecord.ai_analysis.summary}</p>
          {[
            ['Observations', caseRecord.ai_analysis.observations],
            ['Still needs verification', caseRecord.ai_analysis.missing_information],
            ['Questions', caseRecord.ai_analysis.follow_up_questions],
          ].map(([title, items]) =>
            Array.isArray(items) && items.length ? (
              <div key={title as string}>
                <strong>{title as string}</strong>
                <ul>
                  {items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ) : null,
          )}
          <p className="muted small">AI text is informational. Verify it against the cited documents and partner decisions.</p>
        </section>
      )}

      {!readOnly && consented && (
        <div className="row space-between consent-row">
          <span className="muted small">You allowed Saathi to read your records for this conversation.</span>
          <button className="link danger" disabled={busy} onClick={() => run(() => api.setConsent(caseRecord.case_id, false))}>
            Revoke consent
          </button>
        </div>
      )}
    </div>
  );
}
