import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { factValue, sourceLabel } from '../format';
import type { CaseRecord, EvidenceResponse, IntegrationStatus } from '../types';
import { hasActiveConsent } from './CasePanel';

type Run = (operation: () => Promise<CaseRecord>) => Promise<void>;

interface Props {
  caseRecord: CaseRecord;
  integrations: IntegrationStatus;
  readOnly: boolean;
  busy: boolean;
  run: Run;
}

function Confidence({ value }: { value: number }) {
  const level = value >= 0.9 ? 'high' : value >= 0.75 ? 'medium' : 'low';
  return (
    <span className={`confidence confidence-${level}`} title={`Confidence ${value}`}>
      {Math.round(value * 100)}%
    </span>
  );
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

  const upload = async () => {
    setUploadMessage(null);
    await run(async () => {
      for (const file of policyFiles) await api.uploadDocument(caseRecord.case_id, 'policy', file);
      for (const file of billFiles) await api.uploadDocument(caseRecord.case_id, 'bill', file);
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
      setAiError(caught instanceof ApiError ? caught.message : 'Evidence analysis failed. No financial action was started.');
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
                  </td>
                  <td>
                    <strong>{factValue(fact)}</strong>
                  </td>
                  <td className="source">
                    <span className="source-type">{fact.source.type.replace(/_/g, ' ')}</span>
                    {sourceLabel(fact.source)}
                  </td>
                  <td>
                    <Confidence value={fact.confidence} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {evidence && evidence.retrieved_evidence.length > 0 && (
        <section>
          <h3>Cited sources</h3>
          {evidence.retrieved_evidence.map((passage) => (
            <blockquote key={`${passage.document_id}-${passage.clause_id ?? passage.page}`} className="citation">
              <strong>
                {passage.clause_id ? `Clause ${passage.clause_id} / page ${passage.page}` : `${passage.document_name} / page ${passage.page}`}
              </strong>
              {passage.title && <small>{passage.title}</small>}
              <p>{passage.text}</p>
              <small className="muted">{passage.document_name}</small>
            </blockquote>
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
            Text-based PDF, TXT, or JSON. Maximum 5 MB each, four per case. Scanned-PDF OCR is not enabled. Use synthetic files only.
            Uploaded documents pause automated steps until a specialist verifies them.
          </p>
          <div className="upload-grid">
            <label className="field">
              <span>Health policy documents</span>
              <input type="file" accept=".pdf,.txt,.json" multiple onChange={(event) => setPolicyFiles([...(event.target.files ?? [])])} />
            </label>
            <label className="field">
              <span>Hospital bill documents</span>
              <input type="file" accept=".pdf,.txt,.json" multiple onChange={(event) => setBillFiles([...(event.target.files ?? [])])} />
            </label>
          </div>
          <button className="btn" disabled={busy || (!policyFiles.length && !billFiles.length)} onClick={upload}>
            Upload and extract text
          </button>
          {uploadMessage && <p className="muted small">{uploadMessage}</p>}
        </details>
      )}

      {integrations.openai_available && !readOnly && (
        <details className="card-inset">
          <summary>Ask OpenAI to summarize the evidence</summary>
          <label className="checkbox">
            <input type="checkbox" checked={aiConsent} onChange={(event) => setAiConsent(event.target.checked)} />I consent to sending the
            redacted case text and relevant evidence to OpenAI for this analysis.
          </label>
          <button className="btn" disabled={!aiConsent || aiBusy} onClick={analyze}>
            {aiBusy ? 'Analyzing...' : 'Analyze evidence'}
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
          <span className="muted small">Consent: prepare resolution options (granted)</span>
          <button className="link danger" disabled={busy} onClick={() => run(() => api.setConsent(caseRecord.case_id, false))}>
            Revoke consent
          </button>
        </div>
      )}
    </div>
  );
}
