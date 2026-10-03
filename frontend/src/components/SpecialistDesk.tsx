import { useState } from 'react';
import { api, errorMessage } from '../api';
import { dateTime } from '../format';
import type { CaseRecord, SessionUser } from '../types';

interface Props {
  caseRecord: CaseRecord;
  user: SessionUser | null;
  onChange: (record: CaseRecord) => void;
}

// Specialist actions: pick up, message, verify documents, recommend an option, close. The customer still approves actions.
export function SpecialistDesk({ caseRecord, user, onChange }: Props) {
  const [message, setMessage] = useState('');
  const [optionId, setOptionId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const desk = caseRecord.specialist;
  const mine = Boolean(user && desk?.assigned_to === user.user_id);
  const closed = caseRecord.status === 'resolved';
  const feasible = (caseRecord.decision?.options ?? []).filter((option) => option.feasible && !option.handoff);

  const run = async (operation: () => Promise<CaseRecord>, clear = false) => {
    setBusy(true);
    setError(null);
    try {
      onChange(await operation());
      if (clear) setMessage('');
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card-inset specialist-desk">
      <div className="row space-between wrap">
        <strong>Specialist desk: {caseRecord.case_id}</strong>
        {desk?.assigned_to ? (
          <span className="badge badge-green">Picked up by {mine ? 'you' : desk.assigned_name}</span>
        ) : (
          <span className="badge badge-amber">Unassigned</span>
        )}
      </div>

      {!desk?.assigned_to && !closed && (
        <button className="btn btn-primary" disabled={busy} onClick={() => run(() => api.claimCase(caseRecord.case_id))}>
          Pick up this case
        </button>
      )}

      {mine && !closed && (
        <>
          <label className="field">
            <span>Message to the customer (or a recommendation note)</span>
            <textarea className="input" rows={2} maxLength={400} value={message} onChange={(event) => setMessage(event.target.value)} />
          </label>
          <div className="row gap-sm wrap">
            <button
              className="btn"
              disabled={busy || message.trim().length < 2}
              onClick={() => run(() => api.specialistNote(caseRecord.case_id, message.trim(), true), true)}
            >
              Send to customer
            </button>
            <button
              className="btn btn-ghost"
              disabled={busy || message.trim().length < 2}
              onClick={() => run(() => api.specialistNote(caseRecord.case_id, message.trim(), false), true)}
            >
              Save internal note
            </button>
          </div>

          {caseRecord.uploaded_documents.length > 0 && !desk?.verified_documents && (
            <button
              className="btn"
              disabled={busy}
              onClick={() => run(() => api.reviewCase(caseRecord.case_id, { verify_documents: true }))}
            >
              Verify customer documents and recalculate
            </button>
          )}

          {feasible.length > 0 && !['in_progress'].includes(caseRecord.status) && (
            <div className="row gap-sm wrap">
              <select className="input" value={optionId} onChange={(event) => setOptionId(event.target.value)} aria-label="Option to recommend">
                <option value="">Recommend an option...</option>
                {feasible.map((option) => (
                  <option key={option.option_id} value={option.option_id}>
                    {option.title} ({option.scores.total})
                  </option>
                ))}
              </select>
              <button
                className="btn"
                disabled={busy || !optionId}
                onClick={() =>
                  run(() => api.reviewCase(caseRecord.case_id, { verify_documents: false, option_id: optionId, message: message.trim() || undefined }), true)
                }
              >
                Recommend to customer
              </button>
            </div>
          )}

          <button
            className="btn btn-ghost"
            disabled={busy || caseRecord.status === 'in_progress'}
            onClick={() => run(() => api.resolveCase(caseRecord.case_id, message.trim() || 'Resolved with the customer by a Saathi specialist.'), true)}
          >
            Close case as resolved
          </button>
        </>
      )}

      {error && <p className="alert alert-error">{error}</p>}

      {desk && desk.notes.length > 0 && (
        <ul className="notes">
          {desk.notes.map((note, index) => (
            <li key={`${note.at}-${index}`}>
              <small className="muted">
                {dateTime(note.at)} / {note.author} / {note.to_customer ? 'sent to customer' : 'internal'}
              </small>
              <p>{note.text}</p>
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">Specialists can read evidence and recommend, but only the customer can approve partner actions.</p>
    </div>
  );
}
