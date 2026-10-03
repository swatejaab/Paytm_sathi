import type { AgentNodeId, AgentRun } from '../types';

// What each agent step is doing, in the customer's words.
const LIVE_LABELS: Partial<Record<AgentNodeId, [doing: string, done: string]>> = {
  classifier: ['Understanding your question', 'Understood your question'],
  consent_gate: ['Checking your permission', 'Permission checked'],
  context_retriever: ['Reading your account', 'Read your account'],
  policy_rag: ['Checking your policy and rules', 'Checked your policy and rules'],
  bill_auditor: ['Auditing the bill', 'Audited the bill'],
  transaction_auditor: ['Finding the payment', 'Found your recent payments'],
  emi_auditor: ['Checking your loan and salary', 'Checked your loan and salary'],
  decision: ['Comparing your options', 'Compared your options'],
  explainer: ['Writing your answer', 'Answer ready'],
  human_review: ['Bringing in a specialist', 'Specialist notified'],
};

export function LiveSteps({ run }: { run: AgentRun | undefined }) {
  const steps = (run?.steps ?? []).filter((step) => LIVE_LABELS[step.node]);
  return (
    <div className="m-bubble assistant m-live-steps" role="status" aria-live="polite">
      <strong>Saathi is working on it</strong>
      <ol>
        {steps.length === 0 && (
          <li className="active">
            <span className="m-live-dot" /> Starting…
          </li>
        )}
        {steps.map((step, index) => {
          const active = !step.summary && index === steps.length - 1;
          const [doing, done] = LIVE_LABELS[step.node]!;
          return (
            <li key={`${step.node}-${index}`} className={active ? 'active' : step.status === 'error' ? 'error' : 'done'}>
              {active ? <span className="m-live-dot" /> : <span className="m-live-tick">✓</span>}
              <span>
                {active ? `${doing}…` : done}
                {!active && step.tools.length > 0 && <small>{step.tools.length} source{step.tools.length > 1 ? 's' : ''} checked</small>}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export const isRunning = (run: AgentRun | undefined) => run?.outcome === 'running';
