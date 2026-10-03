import { useState, type FormEvent } from 'react';
import { api, errorMessage } from '../api';
import { ProgressRing } from '../components/charts';
import { Icon } from '../components/Icon';
import { ConfirmDialog, EmptyState, ErrorState, Modal, Skeleton, useAsync } from '../components/ui';
import { GOAL_LABELS, inr, shortDate } from '../format';
import { useToast } from '../toast';
import { GOAL_TYPES, type Goal, type GoalInput, type GoalPriority, type GoalStatus, type GoalType } from '../types';

const PRIORITIES: GoalPriority[] = ['high', 'medium', 'low'];
const today = () => new Date().toISOString().slice(0, 10);
const digits = (value: string) => Number(value.replace(/[^0-9]/g, '')) || 0;

interface FormState {
  name: string;
  type: GoalType;
  target: string;
  date: string;
  saved: string;
  monthly: string;
  priority: GoalPriority;
}

const toForm = (goal?: Goal): FormState => ({
  name: goal?.name ?? '',
  type: goal?.type ?? 'emergency_fund',
  target: goal ? String(goal.target_inr) : '',
  date: goal?.target_date ?? '',
  saved: goal ? String(goal.current_savings_inr) : '',
  monthly: goal?.monthly_contribution_inr ? String(goal.monthly_contribution_inr) : '',
  priority: goal?.priority ?? 'medium',
});

function monthsUntil(date: string): number {
  const now = new Date();
  const target = new Date(`${date}T00:00:00`);
  return Math.max((target.getFullYear() - now.getFullYear()) * 12 + target.getMonth() - now.getMonth(), 1);
}

function GoalForm({ goal, onClose, onSaved }: { goal?: Goal; onClose: () => void; onSaved: (goal: Goal) => void }) {
  const [form, setForm] = useState<FormState>(() => toForm(goal));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((current) => ({ ...current, [key]: value }));

  const target = digits(form.target);
  const saved = digits(form.saved);
  const remaining = Math.max(target - saved, 0);
  const required = form.date && form.date > today() && remaining ? Math.ceil(remaining / monthsUntil(form.date)) : null;
  const problem = !form.name.trim()
    ? 'Give your goal a name.'
    : !target
      ? 'Enter a target amount.'
      : saved > target
        ? 'Savings so far can’t be more than the target.'
        : form.date && form.date <= today()
          ? 'Choose a target date in the future.'
          : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    const input: GoalInput = {
      name: form.name.trim(),
      type: form.type,
      target_inr: target,
      target_date: form.date || null,
      current_savings_inr: saved,
      monthly_contribution_inr: form.monthly ? digits(form.monthly) : null,
      priority: form.priority,
    };
    try {
      onSaved(goal ? await api.updateGoal(goal.goal_id, input) : await api.createGoal(input));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={goal ? 'Edit goal' : 'Add a goal'}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" type="submit" form="goal-form" disabled={busy}>
            {busy ? 'Saving...' : goal ? 'Save changes' : 'Add goal'}
          </button>
        </>
      }
    >
      <form id="goal-form" className="form-grid" onSubmit={submit} noValidate>
        <label className="field span-2">
          <span>Goal name</span>
          <input className="input" value={form.name} maxLength={60} onChange={(event) => set('name', event.target.value)} placeholder="e.g. New car" autoFocus />
        </label>
        <label className="field">
          <span>Goal type</span>
          <select className="input" value={form.type} onChange={(event) => set('type', event.target.value as GoalType)}>
            {GOAL_TYPES.map((type) => (
              <option key={type} value={type}>
                {GOAL_LABELS[type]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Priority</span>
          <select className="input" value={form.priority} onChange={(event) => set('priority', event.target.value as GoalPriority)}>
            {PRIORITIES.map((priority) => (
              <option key={priority} value={priority}>
                {priority.charAt(0).toUpperCase() + priority.slice(1)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Target amount (₹)</span>
          <input className="input" inputMode="numeric" value={form.target} onChange={(event) => set('target', event.target.value)} placeholder="1000000" />
        </label>
        <label className="field">
          <span>Target date</span>
          <input className="input" type="date" min={today()} value={form.date} onChange={(event) => set('date', event.target.value)} />
        </label>
        <label className="field">
          <span>Saved so far (₹)</span>
          <input className="input" inputMode="numeric" value={form.saved} onChange={(event) => set('saved', event.target.value)} placeholder="0" />
        </label>
        <label className="field">
          <span>Monthly contribution (₹, optional)</span>
          <input className="input" inputMode="numeric" value={form.monthly} onChange={(event) => set('monthly', event.target.value)} placeholder="Leave blank to let Saathi suggest" />
        </label>
        {target > 0 && (
          <div className="form-preview span-2">
            <span>
              Still needed <strong>{inr(remaining)}</strong>
            </span>
            {required !== null && (
              <span>
                Save <strong>{inr(required)}</strong> a month to reach it by {shortDate(form.date)}
              </span>
            )}
          </div>
        )}
        {error && <p className="alert alert-error span-2">{error}</p>}
      </form>
    </Modal>
  );
}

const STATUS_BADGE: Record<GoalStatus, string> = { active: 'badge-blue', paused: 'badge-amber', completed: 'badge-green' };

function GoalCard({
  goal,
  onEdit,
  onDelete,
  onStatus,
  onAsk,
  busy,
}: {
  goal: Goal;
  onEdit: () => void;
  onDelete: () => void;
  onStatus: (status: GoalStatus) => void;
  onAsk: () => void;
  busy: boolean;
}) {
  return (
    <article className={`card goal goal-${goal.status}`}>
      <header className="goal-head">
        <ProgressRing value={goal.progress_pct} label={`${goal.name} progress`} />
        <div>
          <div className="row gap-sm wrap">
            <span className="badge">{GOAL_LABELS[goal.type]}</span>
            <span className={`badge ${STATUS_BADGE[goal.status]}`}>{goal.status.charAt(0).toUpperCase() + goal.status.slice(1)}</span>
            <span className={`badge priority-${goal.priority}`}>{goal.priority} priority</span>
          </div>
          <h3>{goal.name}</h3>
          <p className="muted small">
            {inr(goal.current_savings_inr)} of {inr(goal.target_inr)}
            {goal.target_date ? ` · by ${shortDate(goal.target_date)}` : ''}
          </p>
        </div>
      </header>
      <dl className="goal-stats">
        <div>
          <dt>Remaining</dt>
          <dd>{inr(goal.remaining_inr)}</dd>
        </div>
        <div>
          <dt>Required monthly</dt>
          <dd>{goal.required_monthly_inr !== null ? inr(goal.required_monthly_inr) : '—'}</dd>
        </div>
        <div>
          <dt>Progress</dt>
          <dd>{Math.round(goal.progress_pct)}%</dd>
        </div>
        <div>
          <dt>Expected completion</dt>
          <dd>{goal.status === 'completed' ? 'Done' : goal.expected_completion ? shortDate(goal.expected_completion) : 'Add a monthly amount'}</dd>
        </div>
      </dl>
      {goal.status === 'active' && goal.on_track !== null && (
        <p className={`goal-track ${goal.on_track ? 'on' : 'off'}`}>
          <Icon name={goal.on_track ? 'check' : 'alert'} size={16} />
          {goal.on_track
            ? 'On track at your monthly contribution.'
            : `Your monthly contribution of ${inr(goal.monthly_contribution_inr ?? 0)} won’t reach the target in time.`}
        </p>
      )}
      <footer className="goal-actions">
        <button className="btn btn-sm" onClick={onAsk}>
          <Icon name="chat" size={16} /> Ask Saathi
        </button>
        <div className="goal-tools">
          {goal.status !== 'completed' && (
            <button className="icon-btn icon-btn-sm" onClick={onEdit} disabled={busy} aria-label="Edit" title="Edit">
              <Icon name="edit" size={17} />
            </button>
          )}
          {goal.status === 'active' && (
            <button className="icon-btn icon-btn-sm" onClick={() => onStatus('paused')} disabled={busy} aria-label="Pause" title="Pause">
              <Icon name="pause" size={17} />
            </button>
          )}
          {goal.status === 'paused' && (
            <button className="icon-btn icon-btn-sm" onClick={() => onStatus('active')} disabled={busy} aria-label="Resume" title="Resume">
              <Icon name="play" size={17} />
            </button>
          )}
          {goal.status !== 'completed' ? (
            <button className="icon-btn icon-btn-sm" onClick={() => onStatus('completed')} disabled={busy} aria-label="Mark as complete" title="Mark as complete">
              <Icon name="check" size={17} />
            </button>
          ) : (
            <button className="icon-btn icon-btn-sm" onClick={() => onStatus('active')} disabled={busy} aria-label="Reopen" title="Reopen">
              <Icon name="play" size={17} />
            </button>
          )}
          <button className="icon-btn icon-btn-sm danger" onClick={onDelete} disabled={busy} aria-label="Delete" title="Delete">
            <Icon name="trash" size={17} />
          </button>
        </div>
      </footer>
    </article>
  );
}

export function Goals({ onAsk }: { onAsk: (text: string) => void }) {
  const toast = useToast();
  const { data, error, loading, reload, setData } = useAsync(() => api.goals());
  const [editing, setEditing] = useState<Goal | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Goal | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const goals = data?.goals ?? [];
  const open = goals.filter((goal) => goal.status !== 'completed');
  const done = goals.filter((goal) => goal.status === 'completed');
  const monthlyNeed = open.filter((goal) => goal.status === 'active').reduce((sum, goal) => sum + (goal.required_monthly_inr ?? 0), 0);

  const replace = (goal: Goal) =>
    setData((current) => ({ goals: current?.goals.some((item) => item.goal_id === goal.goal_id) ? current.goals.map((item) => (item.goal_id === goal.goal_id ? goal : item)) : [...(current?.goals ?? []), goal] }));

  const changeStatus = async (goal: Goal, status: GoalStatus) => {
    setBusyId(goal.goal_id);
    try {
      replace(await api.updateGoal(goal.goal_id, { status }));
      toast(status === 'paused' ? 'Goal paused' : status === 'completed' ? 'Goal marked complete' : 'Goal resumed', 'success');
    } catch (caught) {
      toast(errorMessage(caught), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setBusyId(deleting.goal_id);
    try {
      await api.deleteGoal(deleting.goal_id);
      setData((current) => ({ goals: (current?.goals ?? []).filter((item) => item.goal_id !== deleting.goal_id) }));
      toast('Goal deleted', 'success');
      setDeleting(null);
    } catch (caught) {
      toast(errorMessage(caught), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const ask = (goal: Goal) =>
    onAsk(
      `How can I reach my ${goal.name} goal of ${inr(goal.target_inr)}${goal.target_date ? ` by ${shortDate(goal.target_date)}` : ''}? I have saved ${inr(goal.current_savings_inr)} so far.`,
    );

  return (
    <main className="page goals">
      <header className="page-head">
        <div>
          <h1>Goals</h1>
          <p className="muted">Saathi considers your goals whenever you ask about spending or borrowing.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setEditing('new')}>
          <Icon name="plus" size={18} /> Add Goal
        </button>
      </header>

      {loading && !data ? (
        <div className="goal-grid">
          {[0, 1].map((index) => (
            <div key={index} className="card">
              <Skeleton lines={4} />
            </div>
          ))}
        </div>
      ) : error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : goals.length === 0 ? (
        <EmptyState
          icon="target"
          title="No goals yet"
          body="Add a goal such as an emergency fund, a home, or a car. Saathi will show how much to save each month."
          action={
            <button className="btn btn-primary" onClick={() => setEditing('new')}>
              <Icon name="plus" size={18} /> Add Goal
            </button>
          }
        />
      ) : (
        <>
          {open.length > 0 && (
            <p className="summary-strip">
              <Icon name="target" size={18} />
              {open.length} open goal{open.length === 1 ? '' : 's'} · {inr(open.reduce((sum, goal) => sum + goal.remaining_inr, 0))} still to save
              {monthlyNeed ? ` · about ${inr(monthlyNeed)} a month needed` : ''}
            </p>
          )}
          <div className="goal-grid">
            {open.map((goal) => (
              <GoalCard
                key={goal.goal_id}
                goal={goal}
                busy={busyId === goal.goal_id}
                onEdit={() => setEditing(goal)}
                onDelete={() => setDeleting(goal)}
                onStatus={(status) => void changeStatus(goal, status)}
                onAsk={() => ask(goal)}
              />
            ))}
          </div>
          {done.length > 0 && (
            <details className="completed-goals">
              <summary>Completed ({done.length})</summary>
              <div className="goal-grid">
                {done.map((goal) => (
                  <GoalCard
                    key={goal.goal_id}
                    goal={goal}
                    busy={busyId === goal.goal_id}
                    onEdit={() => setEditing(goal)}
                    onDelete={() => setDeleting(goal)}
                    onStatus={(status) => void changeStatus(goal, status)}
                    onAsk={() => ask(goal)}
                  />
                ))}
              </div>
            </details>
          )}
        </>
      )}

      {editing && (
        <GoalForm
          goal={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={(goal) => {
            replace(goal);
            toast(editing === 'new' ? 'Goal added' : 'Goal updated', 'success');
            setEditing(null);
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete this goal?"
          body={`"${deleting.name}" will be removed. This can't be undone.`}
          confirmLabel="Delete"
          danger
          busy={busyId === deleting.goal_id}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </main>
  );
}
