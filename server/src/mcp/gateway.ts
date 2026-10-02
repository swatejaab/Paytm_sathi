import { verifyApprovalToken, type ApprovalClaims } from '../auth';
import { hasConsent } from '../caseStore';
import { recordAudit } from '../db';
import { canonicalJson, hashPayload } from '../hashing';
import type { CaseAction, CaseRecord, Principal } from '../types';
import { GatewayError, type GatewayDenyCode } from './errors';
import { toolRegistry } from './tools';

export interface InvokeOptions {
  principal: Principal;
  caseRecord: CaseRecord;
  approval?: { token: string; action: CaseAction };
}

export function invokeTool<T = unknown>(name: string, rawInput: Record<string, unknown>, options: InvokeOptions): T {
  const { principal, caseRecord } = options;
  const tool = toolRegistry.get(name);
  const audit = (decision: 'allow' | 'deny', detail: Record<string, unknown>) =>
    recordAudit({
      case_id: caseRecord.case_id,
      actor: principal.sub,
      event: 'mcp_tool_call',
      tool: name,
      scope: tool?.scope ?? null,
      decision,
      detail: { server: tool?.server ?? null, kind: tool?.kind ?? null, ...detail },
    });
  const denial = (code: GatewayDenyCode, reason: string): GatewayError => {
    audit('deny', { code, reason });
    return new GatewayError(code, reason);
  };

  if (!tool) throw denial('unknown_tool', `Tool ${name} is not on the gateway allowlist.`);

  const parsed = tool.input.safeParse(rawInput);
  if (!parsed.success) {
    throw denial('invalid_input', parsed.error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; '));
  }
  const input = parsed.data;

  if (input.case_id !== caseRecord.case_id) throw denial('case_scope', 'Tool input references a different case.');
  if (principal.role !== 'customer' || caseRecord.customer_id !== principal.sub) {
    throw denial('case_scope', 'Only the case owner can run case tools.');
  }
  if (tool.kind === 'read' && !principal.scopes.includes(tool.scope)) {
    throw denial('scope', `Missing scope ${tool.scope}.`);
  }
  if (tool.consent && !hasConsent(caseRecord, tool.consent)) {
    throw denial('consent_required', `Consent "${tool.consent}" is required for ${name}.`);
  }

  if (tool.kind === 'write') {
    if (!options.approval) throw denial('approval_required', 'Write tools require a customer approval token.');
    const { action } = options.approval;
    let claims: ApprovalClaims;
    try {
      claims = verifyApprovalToken(options.approval.token);
    } catch {
      throw denial('approval_invalid', 'The approval token is invalid or expired.');
    }
    if (claims.case_id !== caseRecord.case_id || claims.action_id !== action.action_id || claims.sub !== principal.sub) {
      throw denial('approval_mismatch', 'The approval belongs to a different case, action, or person.');
    }
    if (claims.payload_hash !== action.payload_hash || hashPayload(action.payload) !== claims.payload_hash) {
      throw denial('approval_mismatch', 'The action payload changed after approval. Approve it again.');
    }
    const inputJson = canonicalJson(input);
    const step = action.payload.steps.find((candidate) => candidate.tool === name && canonicalJson(candidate.input) === inputJson);
    if (!step) throw denial('approval_mismatch', 'This tool call is not part of the approved action.');
    if (action.partner_requests.some((request) => request.tool === name)) {
      throw denial('already_executed', 'This approved step has already been submitted.');
    }
  }

  try {
    const result = tool.handler({ principal, caseRecord }, input) as T;
    audit('allow', tool.kind === 'write' ? { action_id: options.approval?.action.action_id } : {});
    return result;
  } catch (error) {
    if (error instanceof GatewayError) throw denial(error.code, error.message);
    throw error;
  }
}
