import type { AgentNodeId } from '../types';

export const GRAPH_VERSION = 'saathi-graph-v1';

export interface AgentNodeInfo {
  id: AgentNodeId;
  label: string;
  responsibility: string;
  decides_money: string;
}

// Mirrors the bounded agent table in the build plan (section 06).
export const AGENT_NODES: AgentNodeInfo[] = [
  {
    id: 'classifier',
    label: 'Event classifier',
    responsibility: 'Classify hospitalization, UPI fraud, or EMI stress; estimate urgency and language.',
    decides_money: 'No. Sets routing metadata only.',
  },
  {
    id: 'consent_gate',
    label: 'Consent gate',
    responsibility: 'Pause the graph until purpose-bound consent is granted.',
    decides_money: 'No. Stops reads without consent.',
  },
  {
    id: 'context_retriever',
    label: 'Context retriever',
    responsibility: 'Load the case-scoped cash and account context through the MCP gateway.',
    decides_money: 'No. Read-only and consent-aware.',
  },
  {
    id: 'policy_rag',
    label: 'Policy RAG analyst',
    responsibility: 'Retrieve applicable clauses, claim requirements, or the event playbook with citations.',
    decides_money: 'No. Reports evidence and uncertainty.',
  },
  {
    id: 'bill_auditor',
    label: 'Bill auditor',
    responsibility: 'Reconcile bill lines, check the stated amount, and flag missing documents.',
    decides_money: 'No. Extracts structured facts.',
  },
  {
    id: 'transaction_auditor',
    label: 'Transaction auditor',
    responsibility: 'Find candidate debits, then gather fraud signals for the one the customer flags.',
    decides_money: 'No. Extracts structured facts.',
  },
  {
    id: 'emi_auditor',
    label: 'EMI auditor',
    responsibility: 'Load the loan, due date, and salary schedule; check what is committed before the EMI date.',
    decides_money: 'No. Extracts structured facts.',
  },
  {
    id: 'decision',
    label: 'Decision service',
    responsibility: 'Deterministic coverage, exact gap, affordability, guardrails, and option scoring.',
    decides_money: 'Calculates only; rules block unsafe options.',
  },
  {
    id: 'explainer',
    label: 'Resolution explainer',
    responsibility: "Explain the ranked choices and next step in the customer's language.",
    decides_money: 'No. Cannot change ranking inputs.',
  },
  {
    id: 'human_review',
    label: 'Human handoff',
    responsibility: 'Route failures, low confidence, or conflicts to a specialist with the passport.',
    decides_money: 'No.',
  },
  {
    id: 'action_preparer',
    label: 'Action preparer',
    responsibility: 'Build the exact partner payload and its hash; pause for customer approval.',
    decides_money: 'No. Prepares only.',
  },
  {
    id: 'action_tracker',
    label: 'Action tracker',
    responsibility: 'Run approved writes through the gateway and track partner callbacks.',
    decides_money: 'Writes only after the gateway verifies approval.',
  },
];

export const NODE_LABELS = Object.fromEntries(AGENT_NODES.map((node) => [node.id, node.label])) as Record<
  AgentNodeId,
  string
>;
