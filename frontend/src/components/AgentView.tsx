import { useEffect, useState } from 'react';
import { api } from '../api';
import { timeOnly } from '../format';
import type { AgentNodeInfo, AgentRun, CaseRecord, PlaybookInfo } from '../types';

const TRIGGER_LABELS: Record<string, string> = {
  intake: 'Customer told their story',
  consent_granted: 'Customer granted consent',
  transaction_confirmed: 'Customer flagged a transaction',
  documents_updated: 'Customer added documents',
  action_prepared: 'Customer chose an option',
  action_approved: 'Customer approved the action',
};

const OUTCOME_LABELS: Record<string, string> = {
  awaiting_consent: 'Paused for consent',
  awaiting_transaction: 'Paused for the customer',
  routed_to_specialist: 'Routed to a specialist',
  options_ready: 'Options ready',
};

function RunCard({ run, nodes, open, onToggle }: { run: AgentRun; nodes: Map<string, AgentNodeInfo>; open: boolean; onToggle: () => void }) {
  const tools = run.steps.reduce((sum, step) => sum + step.tools.length, 0);
  const failed = run.steps.some((step) => step.status === 'error');
  return (
    <li className="agent-run card-inset">
      <button className="agent-run-head" onClick={onToggle} aria-expanded={open}>
        <span>
          <strong>{TRIGGER_LABELS[run.trigger] ?? run.trigger}</strong>
          <small className="muted">
            {' '}
            / {timeOnly(run.started_at)} / {run.steps.length} node{run.steps.length === 1 ? '' : 's'} / {tools} tool call{tools === 1 ? '' : 's'}
          </small>
        </span>
        <span className={`badge ${failed ? 'badge-red' : run.outcome.startsWith('awaiting') ? 'badge-amber' : 'badge-green'}`}>
          {OUTCOME_LABELS[run.outcome] ?? run.outcome.replace(/_/g, ' ')}
        </span>
      </button>
      {open && (
        <ol className="agent-steps">
          {run.steps.map((step, index) => (
            <li key={`${step.node}-${index}`} className={`agent-step agent-step-${step.status}`}>
              <span className="agent-step-dot" aria-hidden />
              <div className="agent-step-body">
                <div className="row gap-sm wrap space-between">
                  <strong>{step.label}</strong>
                  <small className="muted">{step.duration_ms} ms</small>
                </div>
                <p className="small">{step.summary}</p>
                {step.tools.length > 0 && (
                  <div className="row gap-sm wrap">
                    {step.tools.map((tool, toolIndex) => (
                      <code key={`${tool}-${toolIndex}`} className="tool-chip">
                        {tool}
                      </code>
                    ))}
                  </div>
                )}
                {nodes.get(step.node) && <small className="muted">Money authority: {nodes.get(step.node)!.decides_money}</small>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

export function AgentView({ caseRecord }: { caseRecord: CaseRecord }) {
  const [nodes, setNodes] = useState<Map<string, AgentNodeInfo>>(new Map());
  const [engine, setEngine] = useState('');
  const [playbooks, setPlaybooks] = useState<PlaybookInfo[]>([]);
  const runs = [...(caseRecord.agent_runs ?? [])].reverse();
  const [openRun, setOpenRun] = useState<string | null>(null);
  const expanded = openRun ?? runs.find((run) => run.steps.length > 1)?.run_id ?? runs[0]?.run_id ?? null;

  useEffect(() => {
    let cancelled = false;
    api
      .agentGraph()
      .then((result) => {
        if (cancelled) return;
        setNodes(new Map(result.nodes.map((item) => [item.id, item])));
        setEngine(`${result.engine} / ${result.graph}`);
      })
      .catch(() => undefined);
    api
      .playbooks()
      .then((result) => !cancelled && setPlaybooks(result.playbooks))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const active = playbooks.find((playbook) => playbook.id === caseRecord.playbook_id) ?? playbooks.find((playbook) => playbook.event_type === caseRecord.event_type);

  if (!runs.length) {
    return <p className="muted empty-inline">No agent runs yet. They appear here as soon as Saathi works on your case.</p>;
  }

  return (
    <div className="agents">
      <p className="muted small">
        A bounded agent graph{engine ? ` (${engine})` : ''} handles each step. Agents gather and explain evidence through the MCP
        gateway; deterministic rules do the maths, and only you can approve an action.
      </p>
      {active && (
        <div className="card-inset playbook-card">
          <div className="row space-between wrap">
            <strong>
              Playbook: {active.id} v{active.version}
            </strong>
            <span className={`badge ${active.engine === 'declarative' ? 'badge-green' : 'badge-blue'}`}>
              {active.engine === 'declarative' ? 'Declarative YAML' : `Rules: ${active.engine.replace('builtin:', '')}`}
            </span>
          </div>
          <small className="muted">
            {active.title}. The gateway grants this case only these tools; anything else is denied and logged.
          </small>
          <div className="row gap-sm wrap">
            {active.tools.read.map((tool) => (
              <code key={tool} className="tool-chip">
                {tool}
              </code>
            ))}
            {active.tools.write.map((tool) => (
              <code key={tool} className="tool-chip tool-chip-write" title="Write tool: needs your approval">
                {tool}
              </code>
            ))}
          </div>
          <small className="muted">
            {playbooks.length} playbooks on the same engine: {playbooks.map((playbook) => playbook.id).join(', ')}
          </small>
        </div>
      )}
      <ol className="agent-runs">
        {runs.map((run) => (
          <RunCard
            key={run.run_id}
            run={run}
            nodes={nodes}
            open={expanded === run.run_id}
            onToggle={() => setOpenRun(expanded === run.run_id ? '' : run.run_id)}
          />
        ))}
      </ol>
    </div>
  );
}
