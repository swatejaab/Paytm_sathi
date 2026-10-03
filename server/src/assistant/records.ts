// Reads the customer's health policy, current hospital admission, and cash position through the partner MCP servers.
// Runs only after the customer allows Saathi to read their records; every call goes through the gateway, which
// checks consent and the playbook allowlist and writes the audit trail. A partner that fails is treated as "not found".
import { nowIso } from '../db';
import { formatDay, formatInr } from '../decision';
import { invokeTool } from '../mcp/gateway';
import type { AdmissionLookup, FiData, PolicyLookup } from '../mcp/tools';
import type { CaseRecord, FetchedRecords, Principal } from '../types';

export async function fetchHospitalRecords(record: CaseRecord, principal: Principal): Promise<FetchedRecords> {
  const call = async <T>(tool: string, input: Record<string, unknown> = {}): Promise<T | null> => {
    try {
      return await invokeTool<T>(tool, { case_id: record.case_id, ...input }, { principal, caseRecord: record });
    } catch {
      return null;
    }
  };
  const policy = await call<PolicyLookup>('insurer.get_policy');
  const admission = await call<AdmissionLookup>('hospital.get_bill');
  const artefact = await call<{ consent_handle: string }>('aa.request_consent', {
    purpose: 'hospital_bill_plan',
    fi_types: ['DEPOSIT', 'MUTUAL_FUNDS'],
  });
  const fi = artefact ? await call<FiData>('aa.fetch_fi_data', { consent_handle: artefact.consent_handle }) : null;

  let cash: FetchedRecords['cash'] = null;
  if (fi) {
    const balance = fi.accounts.reduce((sum, account) => sum + account.balance_inr, 0);
    const committed = fi.scheduled_debits.reduce((sum, debit) => sum + debit.amount_inr, 0);
    cash = {
      balance_inr: balance,
      next_salary_date: fi.next_salary_date,
      scheduled_debits: fi.scheduled_debits,
      safe_to_pay_inr: Math.max(balance - committed, 0),
      mutual_funds: fi.mutual_funds.map(({ name, value_inr }) => ({ name, value_inr })),
    };
  }

  return {
    checked_at: nowIso(),
    policy: policy?.found
      ? {
          policy_name: policy.policy_name,
          insurer: policy.insurer,
          document_id: policy.document_id,
          file_name: policy.file_name,
          sum_insured_inr: policy.sum_insured_inr,
          insured_members: policy.insured_members,
          cashless_network: policy.cashless_network,
        }
      : null,
    admission: admission?.found
      ? {
          admission_id: admission.admission_id,
          hospital: admission.hospital,
          patient: admission.patient,
          relation: admission.relation,
          ward: admission.ward,
          reason: admission.reason,
          cashless: admission.cashless,
          document_id: admission.bill.document_id,
          document_name: admission.bill.file_name,
          total_inr: admission.bill.total_inr,
          lines: admission.bill.lines.map(({ line, description, amount_inr, days, non_medical_inr }) => ({
            line,
            description,
            amount_inr,
            ...(days ? { days } : {}),
            ...(non_medical_inr !== undefined ? { non_medical_inr } : {}),
          })),
          missing_documents: admission.missing_documents,
        }
      : null,
    cash,
  };
}

// "Balance ₹38,420 - Rent ₹22,000 (7 Oct) - Paytm credit card bill ₹6,420 (8 Oct), before salary on 10 Oct"
export function payNowSource(cash: NonNullable<FetchedRecords['cash']>): string {
  const debits = cash.scheduled_debits.map((debit) => ` - ${debit.title} ${formatInr(debit.amount_inr)} (${formatDay(debit.due_date)})`).join('');
  const salary = cash.next_salary_date ? `, before salary on ${formatDay(cash.next_salary_date)}` : '';
  return debits
    ? `Bank balance ${formatInr(cash.balance_inr)}${debits}${salary}`
    : `Bank balance ${formatInr(cash.balance_inr)}, nothing else due${salary}`;
}

// "your father's ICU stay at City Hospital, Thane"
export function admissionPhrase(admission: NonNullable<FetchedRecords['admission']>): string {
  const who = admission.relation === 'self' ? 'your' : `your ${admission.relation}'s`;
  return `${who} ${admission.ward === 'ICU' ? 'ICU stay' : 'admission'} at ${admission.hospital}`;
}
