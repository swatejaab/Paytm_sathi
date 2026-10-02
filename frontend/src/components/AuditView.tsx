import { useEffect, useState } from 'react';
import { api } from '../api';
import { timeOnly } from '../format';
import type { AuditEvent, CaseRecord, ToolInfo } from '../types';

function describe(event: AuditEvent): string {
  const detail = event.detail;
  if (event.decision === 'deny' && typeof detail.reason === 'string') return detail.reason;
  if (event.event === 'action_approved') return `Payload ${String(detail.payload_hash ?? '').slice(0, 12)} approved`;
  if (event.event === 'partner_event') return `${String(detail.status)} / ${String(detail.reference ?? '')}`;
  if (event.event === 'document_uploaded') return `${String(detail.document_type)} / ${String(detail.characters)} characters (content not logged)`;
  if (typeof detail.purpose === 'string') return detail.purpose.replace(/_/g, ' ');
  if (typeof detail.server === 'string') return `${detail.server} MCP / ${String(detail.kind)}`;
  return '';
}

export function AuditView({ caseRecord }: { caseRecord: CaseRecord }) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [showTools, setShowTools] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .audit(caseRecord.case_id)
      .then((result) => !cancelled && setEvents(result.events))
      .catch(() => !cancelled && setEvents([]));
    return () => {
      cancelled = true;
    };
  }, [caseRecord.case_id, caseRecord.updated_at]);

  useEffect(() => {
    if (showTools && !tools.length) {
      api
        .tools()
        .then((result) => setTools(result.tools))
        .catch(() => setTools([]));
    }
  }, [showTools, tools.length]);

  const denied = events.filter((event) => event.decision === 'deny').length;
  const toolCalls = events.filter((event) => event.event === 'mcp_tool_call').length;

  return (
    <div className="audit">
      <div className="audit-summary">
        <div>
          <strong>{toolCalls}</strong>
          <small>MCP tool calls</small>
        </div>
        <div>
          <strong>{denied}</strong>
          <small>Denied by the gateway</small>
        </div>
        <div>
          <strong>{events.filter((event) => event.event === 'action_approved').length}</strong>
          <small>Customer approvals</small>
        </div>
      </div>
      <p className="muted small">
        The MCP gateway checks identity, case scope, consent, and approval on every call. It logs tool names, scopes, and
        decisions, never document contents or keys.
      </p>
      <table className="table audit-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Event</th>
            <th>Tool</th>
            <th>Decision</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.id}>
              <td>{timeOnly(event.at)}</td>
              <td>
                {event.event.replace(/_/g, ' ')}
                <small className="muted"> {event.actor}</small>
              </td>
              <td>{event.tool ? <code>{event.tool}</code> : '-'}</td>
              <td>
                <span className={`badge decision-${event.decision}`}>{event.decision}</span>
              </td>
              <td className="small">{describe(event)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <button className="link" onClick={() => setShowTools(!showTools)}>
        {showTools ? 'Hide' : 'Show'} the MCP tool catalog
      </button>
      {showTools && (
        <table className="table">
          <thead>
            <tr>
              <th>Tool</th>
              <th>Server</th>
              <th>Kind</th>
              <th>Gate</th>
              <th>Fixture</th>
            </tr>
          </thead>
          <tbody>
            {tools.map((tool) => (
              <tr key={tool.name}>
                <td>
                  <code>{tool.name}</code>
                  <small className="muted"> {tool.description}</small>
                </td>
                <td>{tool.server}</td>
                <td>
                  <span className={`badge ${tool.kind === 'write' ? 'badge-amber' : ''}`}>{tool.kind}</span>
                </td>
                <td className="small">{[tool.consent && 'consent', tool.approval_required && 'approval token'].filter(Boolean).join(' + ') || 'case scope'}</td>
                <td className="small">{tool.fixture}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
