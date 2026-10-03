import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, settings } from './config';
import { deleteGoalRow, getPreferences, listGoalRows, savePreferences, upsertGoalRow } from './db';

export const GOAL_TYPES = [
  'emergency_fund',
  'home',
  'vehicle',
  'education',
  'wedding',
  'travel',
  'retirement',
  'debt_repayment',
  'custom',
] as const;
export type GoalType = (typeof GOAL_TYPES)[number];
export type GoalStatus = 'active' | 'paused' | 'completed';
export type GoalPriority = 'high' | 'medium' | 'low';

export interface Goal {
  goal_id: string;
  user_id: string;
  name: string;
  type: GoalType;
  target_inr: number;
  target_date: string | null;
  current_savings_inr: number;
  monthly_contribution_inr: number | null;
  priority: GoalPriority;
  status: GoalStatus;
  created_at: string;
  updated_at: string;
}

export interface GoalView extends Goal {
  remaining_inr: number;
  progress_pct: number;
  months_left: number | null;
  required_monthly_inr: number | null;
  expected_completion: string | null;
  on_track: boolean | null;
}

export type GoalInput = Pick<
  Goal,
  'name' | 'type' | 'target_inr' | 'target_date' | 'current_savings_inr' | 'monthly_contribution_inr' | 'priority'
>;

const now = () => new Date().toISOString();

const monthsBetween = (from: string, to: string): number => {
  const a = new Date(`${from}T00:00:00Z`);
  const b = new Date(`${to}T00:00:00Z`);
  const months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()) + (b.getUTCDate() >= a.getUTCDate() ? 0 : -1);
  return Math.max(months, 0);
};

const addMonths = (date: string, months: number): string => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCMonth(value.getUTCMonth() + months);
  return value.toISOString().slice(0, 10);
};

// Deterministic goal maths. Required monthly is rounded up to the next INR 100 so the goal is not missed by rounding.
export function computeGoal(goal: Goal, today = settings.demoDate): GoalView {
  const remaining = Math.max(goal.target_inr - goal.current_savings_inr, 0);
  const progress = goal.target_inr > 0 ? Math.min(Math.round((goal.current_savings_inr / goal.target_inr) * 100), 100) : 0;
  const monthsLeft = goal.target_date ? monthsBetween(today, goal.target_date) : null;
  const required =
    remaining === 0 ? 0 : monthsLeft === null ? null : monthsLeft === 0 ? remaining : Math.ceil(remaining / monthsLeft / 100) * 100;
  const contribution = goal.monthly_contribution_inr;
  const expected =
    remaining === 0
      ? today
      : contribution && contribution > 0 && goal.status === 'active'
        ? addMonths(today, Math.ceil(remaining / contribution))
        : null;
  return {
    ...goal,
    remaining_inr: remaining,
    progress_pct: progress,
    months_left: monthsLeft,
    required_monthly_inr: required,
    expected_completion: expected,
    on_track: required === null || !contribution ? null : contribution >= required,
  };
}

function inferType(name: string): GoalType {
  const lower = name.toLowerCase();
  if (lower.includes('emergency')) return 'emergency_fund';
  if (/home|house|flat|down payment/.test(lower)) return 'home';
  if (/car|bike|vehicle|scooter/.test(lower)) return 'vehicle';
  if (/trip|travel|vacation|holiday/.test(lower)) return 'travel';
  if (/education|school|college|course/.test(lower)) return 'education';
  if (/wedding|marriage/.test(lower)) return 'wedding';
  if (/retire/.test(lower)) return 'retirement';
  if (/loan|debt|repay/.test(lower)) return 'debt_repayment';
  return 'custom';
}

// Starting goals from the customer's sample records, written once so later edits and deletes stick.
function seedGoals(userId: string): void {
  const preferences = getPreferences(userId);
  if (preferences.goals_seeded) return;
  const file = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'twin.json'), 'utf8')) as {
    customers: Record<string, { goals?: { goal: string; target_inr: number; saved_inr: number; target_date: string }[] }>;
  };
  const seeds = file.customers[userId]?.goals ?? [];
  seeds.forEach((seed, index) => {
    const created = new Date(Date.now() - (seeds.length - index) * 1000).toISOString();
    const type = inferType(seed.goal);
    upsertGoalRow({
      goal_id: `GOAL-${userId.slice(-2)}-${index + 1}`,
      user_id: userId,
      name: seed.goal,
      type,
      target_inr: seed.target_inr,
      target_date: seed.target_date,
      current_savings_inr: seed.saved_inr,
      monthly_contribution_inr: null,
      priority: type === 'emergency_fund' ? 'high' : 'medium',
      status: 'active',
      created_at: created,
      updated_at: created,
    } satisfies Goal);
  });
  savePreferences(userId, { ...preferences, goals_seeded: true });
}

export function listGoals(userId: string): GoalView[] {
  seedGoals(userId);
  const order: Record<GoalStatus, number> = { active: 0, paused: 1, completed: 2 };
  return listGoalRows<Goal>(userId)
    .map((goal) => computeGoal(goal))
    .sort((a, b) => order[a.status] - order[b.status] || a.created_at.localeCompare(b.created_at));
}

export function findGoal(userId: string, goalId: string): Goal | null {
  seedGoals(userId);
  return listGoalRows<Goal>(userId).find((goal) => goal.goal_id === goalId) ?? null;
}

export function createGoal(userId: string, input: GoalInput): GoalView {
  seedGoals(userId);
  const stamp = now();
  const goal: Goal = {
    goal_id: `GOAL-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`,
    user_id: userId,
    ...input,
    status: input.current_savings_inr >= input.target_inr ? 'completed' : 'active',
    created_at: stamp,
    updated_at: stamp,
  };
  upsertGoalRow(goal);
  return computeGoal(goal);
}

export function updateGoal(userId: string, goalId: string, patch: Partial<GoalInput> & { status?: GoalStatus }): GoalView | null {
  const existing = findGoal(userId, goalId);
  if (!existing) return null;
  const goal: Goal = { ...existing, ...patch, updated_at: now() };
  upsertGoalRow(goal);
  return computeGoal(goal);
}

export function removeGoal(userId: string, goalId: string): boolean {
  seedGoals(userId);
  return deleteGoalRow(userId, goalId);
}

export const activeGoals = (userId: string) => listGoals(userId).filter((goal) => goal.status === 'active');
