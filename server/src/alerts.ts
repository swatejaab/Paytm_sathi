import { settings } from './config';
import { listCases, getPreferences, recordAudit, savePreferences } from './db';
import { calculateEmiShortfall, formatDay, formatInr } from './decision';
import { fixtures } from './fixtures';
import type { EventType } from './types';

export interface ProactiveAlert {
  alert_id: string;
  event_type: EventType;
  severity: 'high' | 'medium';
  title: string;
  detail: string;
  suggested_message: string;
}

const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) / 86_400_000);

// Deterministic watchers over the customer's own synthetic records. Nothing leaves Saathi.
function detectAlerts(customerId: string): ProactiveAlert[] {
  const alerts: ProactiveAlert[] = [];
  const profile = fixtures.profiles[customerId];
  const loans = fixtures.loans.accounts[customerId];
  if (profile && loans) {
    for (const loan of loans.loans) {
      const daysToDue = daysBetween(settings.demoDate, loan.next_due_date);
      const { shortfall_inr: shortfall } = calculateEmiShortfall({
        emi_inr: loan.emi_inr,
        account_balance_inr: profile.account_balance_inr,
        committed_before_due_inr: loans.committed_before_due_inr,
      });
      if (shortfall > 0 && daysToDue >= 0 && daysToDue <= 7) {
        alerts.push({
          alert_id: `emi:${loan.loan_id}:${loan.next_due_date}`,
          event_type: 'emi_shortfall',
          severity: daysToDue <= 3 ? 'high' : 'medium',
          title: `Your ${formatInr(loan.emi_inr)} EMI is due in ${daysToDue} day${daysToDue === 1 ? '' : 's'}, ${formatInr(shortfall)} short`,
          detail: `${loan.product} ${loan.loan_id} is due ${formatDay(loan.next_due_date)}. Salary is ${loans.salary.status}${loans.salary.status === 'delayed' ? ` to ${formatDay(loans.salary.expected_date)}` : ''}.`,
          suggested_message: `Salary delayed hai aur ${formatInr(loan.emi_inr)} ki EMI ${loan.next_due_date} ko due hai, ${formatInr(shortfall)} kam hain. Kya options hain?`,
        });
      }
    }
  }
  for (const transaction of fixtures.payments.accounts[customerId]?.transactions ?? []) {
    const daysSince = daysBetween(transaction.occurred_at, settings.demoDate);
    if (transaction.status === 'failed_debited' && daysSince > 1) {
      alerts.push({
        alert_id: `refund:${transaction.transaction_id}`,
        event_type: 'failed_refund',
        severity: 'medium',
        title: `Failed ${formatInr(transaction.amount_inr)} payment to ${transaction.counterparty} not refunded yet`,
        detail: `Debited ${daysSince} days ago but not credited; refunds are due by T+1, so ${formatInr((daysSince - 1) * 100)} compensation may be owed.`,
        suggested_message: `${formatInr(transaction.amount_inr)} ka UPI payment failed ho gaya, paise kat gaye par refund nahi aaya.`,
      });
      continue;
    }
    if (transaction.direction !== 'debit' || transaction.recognized_device || !transaction.first_time_counterparty) continue;
    alerts.push({
      alert_id: `txn:${transaction.transaction_id}`,
      event_type: 'upi_dispute',
      severity: 'high',
      title: `Unusual ${formatInr(transaction.amount_inr)} debit to ${transaction.counterparty}`,
      detail: `${transaction.channel} from an unrecognized device (${transaction.device}) at ${transaction.occurred_at.slice(11, 16)}, first payment to this payee.`,
      suggested_message: `Mere account se ${formatInr(transaction.amount_inr)} ka UPI payment hua jo maine nahi kiya. Kya karun?`,
    });
  }
  return alerts;
}

// Hide alerts the customer already acted on, so the card disappears once a case covers it.
function alreadyHandled(customerId: string, alert: ProactiveAlert): boolean {
  return listCases(customerId).some((record) =>
    alert.alert_id.startsWith('refund:')
      ? record.evidence?.transaction?.transaction_id === alert.alert_id.slice(7) || (record.event_type === 'failed_refund' && record.status !== 'intake')
      : alert.alert_id.startsWith('txn:')
      ? record.evidence?.transaction?.transaction_id === alert.alert_id.slice(4) ||
        (record.event_type === 'upi_dispute' && record.created_at.slice(0, 10) >= settings.demoDate && record.status !== 'intake')
      : record.event_type === alert.event_type && record.status !== 'intake',
  );
}

export function alertsFor(customerId: string): { enabled: boolean; alerts: ProactiveAlert[] } {
  const preferences = getPreferences(customerId);
  if (!preferences.alerts_enabled) return { enabled: false, alerts: [] };
  const dismissed = new Set(preferences.dismissed_alerts ?? []);
  const alerts = detectAlerts(customerId).filter((alert) => !dismissed.has(alert.alert_id) && !alreadyHandled(customerId, alert));
  recordAudit({ actor: customerId, event: 'proactive_alerts_checked', detail: { count: alerts.length } });
  return { enabled: true, alerts };
}

export function setAlertsEnabled(customerId: string, enabled: boolean): void {
  savePreferences(customerId, { ...getPreferences(customerId), alerts_enabled: enabled });
  recordAudit({ actor: customerId, event: enabled ? 'alerts_enabled' : 'alerts_disabled' });
}

export function dismissAlert(customerId: string, alertId: string): void {
  const preferences = getPreferences(customerId);
  const dismissed = new Set(preferences.dismissed_alerts ?? []);
  dismissed.add(alertId);
  savePreferences(customerId, { ...preferences, dismissed_alerts: [...dismissed].slice(-50) });
}
