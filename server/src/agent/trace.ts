import { newId } from '../caseStore';
import { nowIso } from '../db';
import type { AgentNodeId, AgentRun, AgentStep, AgentTrigger, CaseRecord } from '../types';
import { GRAPH_VERSION, NODE_LABELS } from './nodes';

const MAX_RUNS_KEPT = 20;

export class RunTracer {
  readonly run: AgentRun;
  private current: { step: AgentStep; startedMs: number } | null = null;

  constructor(record: CaseRecord, trigger: AgentTrigger) {
    this.run = {
      run_id: newId('RUN'),
      trigger,
      graph: GRAPH_VERSION,
      started_at: nowIso(),
      finished_at: null,
      outcome: 'running',
      steps: [],
    };
    record.agent_runs ??= [];
    record.agent_runs.push(this.run);
    if (record.agent_runs.length > MAX_RUNS_KEPT) record.agent_runs.splice(0, record.agent_runs.length - MAX_RUNS_KEPT);
  }

  begin(node: AgentNodeId): void {
    const step: AgentStep = {
      node,
      label: NODE_LABELS[node],
      status: 'ok',
      started_at: nowIso(),
      duration_ms: 0,
      summary: '',
      tools: [],
    };
    this.run.steps.push(step);
    this.current = { step, startedMs: performance.now() };
  }

  tool(name: string): void {
    this.current?.step.tools.push(name);
  }

  end(status: AgentStep['status'], summary: string): void {
    if (!this.current) return;
    this.current.step.status = status;
    this.current.step.summary = summary;
    this.current.step.duration_ms = Math.round((performance.now() - this.current.startedMs) * 10) / 10;
    this.current = null;
  }

  finish(outcome: string): void {
    this.run.finished_at = nowIso();
    this.run.outcome = outcome;
  }
}

// Single-step runs for work that happens outside the graph (prepare, approve).
export function traceStandalone(
  record: CaseRecord,
  trigger: AgentTrigger,
  node: AgentNodeId,
  summary: string,
  tools: string[] = [],
): void {
  const tracer = new RunTracer(record, trigger);
  tracer.begin(node);
  tools.forEach((tool) => tracer.tool(tool));
  tracer.end('ok', summary);
  tracer.finish(summary);
}
