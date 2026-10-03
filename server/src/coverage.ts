// Coverage rules engine: maps every bill line to payable / capped / excluded with the governing clause,
// then applies the per-claim deductible and the sum-insured ceiling. Pure and deterministic.

export const COVERAGE_RULES_VERSION = 'coverage-v1';

export interface CoverageSchedule {
  sum_insured_inr: number;
  room_rent_limit_per_day_inr: number;
  deductible_per_claim_inr: number;
  room_clause_id: string;
  non_medical_clause_id: string;
  deductible_clause_id: string;
  eligible_clause_id: string;
}

export interface CoverageBillLine {
  line: number;
  description: string;
  amount_inr: number;
  days?: number;
  non_medical_inr?: number;
}

export type LineCategory = 'room' | 'pharmacy' | 'medical';
export type LineStatus = 'payable' | 'capped' | 'partly_excluded' | 'excluded';

export interface LineAssessment {
  line: number;
  description: string;
  category: LineCategory;
  billed_inr: number;
  payable_inr: number;
  not_payable_inr: number;
  status: LineStatus;
  clause_id: string;
  reason: string;
}

export interface CoverageAssessment {
  rules_version: string;
  lines: LineAssessment[];
  payable_before_deductible_inr: number;
  deductible_inr: number;
  deductible_clause_id: string;
  sum_insured_inr: number;
  estimated_coverage_inr: number;
  not_covered_inr: number;
  assumptions: string[];
}

const inr = (amount: number) => `INR ${Math.round(amount).toLocaleString('en-IN')}`;

export function categorize(description: string): LineCategory {
  const text = description.toLowerCase();
  if (/\b(room|ward|nursing|bed|icu stay|accommodation)\b/.test(text)) return 'room';
  if (/\b(pharmacy|medicine|medicines|drug|consumable|consumables|supplies)\b/.test(text)) return 'pharmacy';
  return 'medical';
}

// "Room charges (3 days)" or "Room x 4 nights" -> 3 / 4.
export function roomDays(line: CoverageBillLine): number | null {
  if (line.days && line.days > 0) return line.days;
  const match = /(\d+)\s*(?:days?|nights?)\b/i.exec(line.description);
  return match ? Number(match[1]) : null;
}

export function assessCoverage(lines: CoverageBillLine[], schedule: CoverageSchedule): CoverageAssessment {
  const assumptions: string[] = [];
  const assessed = lines.map((line): LineAssessment => {
    const category = categorize(line.description);
    const base = { line: line.line, description: line.description, category, billed_inr: line.amount_inr };

    if (category === 'room') {
      const days = roomDays(line);
      if (!days) {
        assumptions.push(`Line ${line.line}: number of room days not stated; the room limit could not be applied.`);
        return { ...base, payable_inr: line.amount_inr, not_payable_inr: 0, status: 'payable', clause_id: schedule.room_clause_id, reason: 'Room days not stated, so the full amount is shown as payable pending insurer review.' };
      }
      const cap = days * schedule.room_rent_limit_per_day_inr;
      const payable = Math.min(line.amount_inr, cap);
      return {
        ...base,
        payable_inr: payable,
        not_payable_inr: line.amount_inr - payable,
        status: payable < line.amount_inr ? 'capped' : 'payable',
        clause_id: schedule.room_clause_id,
        reason:
          payable < line.amount_inr
            ? `${days} day${days === 1 ? '' : 's'} at ${inr(line.amount_inr / days)} a day; the policy pays up to ${inr(schedule.room_rent_limit_per_day_inr)} a day (${inr(cap)}).`
            : `${days} day${days === 1 ? '' : 's'} within the ${inr(schedule.room_rent_limit_per_day_inr)} daily room limit.`,
      };
    }

    if (category === 'pharmacy') {
      const nonMedical = Math.min(line.non_medical_inr ?? 0, line.amount_inr);
      if (line.non_medical_inr === undefined) {
        assumptions.push(`Line ${line.line}: non-medical consumables are not itemised; the insurer may deduct them.`);
      }
      return {
        ...base,
        payable_inr: line.amount_inr - nonMedical,
        not_payable_inr: nonMedical,
        status: nonMedical === 0 ? 'payable' : nonMedical === line.amount_inr ? 'excluded' : 'partly_excluded',
        clause_id: nonMedical > 0 ? schedule.non_medical_clause_id : schedule.eligible_clause_id,
        reason: nonMedical > 0 ? `${inr(nonMedical)} of non-medical consumables are not payable.` : 'Medicines prescribed during the stay are eligible.',
      };
    }

    return {
      ...base,
      payable_inr: line.amount_inr,
      not_payable_inr: 0,
      status: 'payable',
      clause_id: schedule.eligible_clause_id,
      reason: 'Eligible inpatient expense.',
    };
  });

  const payableBeforeDeductible = assessed.reduce((sum, line) => sum + line.payable_inr, 0);
  const deductible = Math.min(schedule.deductible_per_claim_inr, payableBeforeDeductible);
  const coverage = Math.min(Math.max(payableBeforeDeductible - deductible, 0), schedule.sum_insured_inr);
  const billed = assessed.reduce((sum, line) => sum + line.billed_inr, 0);
  return {
    rules_version: COVERAGE_RULES_VERSION,
    lines: assessed,
    payable_before_deductible_inr: payableBeforeDeductible,
    deductible_inr: deductible,
    deductible_clause_id: schedule.deductible_clause_id,
    sum_insured_inr: schedule.sum_insured_inr,
    estimated_coverage_inr: coverage,
    not_covered_inr: billed - coverage,
    assumptions,
  };
}
