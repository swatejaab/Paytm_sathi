export type GatewayDenyCode =
  | 'unknown_tool'
  | 'invalid_input'
  | 'case_scope'
  | 'scope'
  | 'consent_required'
  | 'approval_required'
  | 'approval_invalid'
  | 'approval_mismatch'
  | 'already_executed'
  | 'playbook_scope'
  | 'partner_unavailable'
  | 'partner_error'
  | 'not_found';

export const GATEWAY_STATUS: Record<GatewayDenyCode, number> = {
  unknown_tool: 400,
  invalid_input: 422,
  case_scope: 404,
  scope: 403,
  consent_required: 403,
  approval_required: 403,
  approval_invalid: 403,
  approval_mismatch: 409,
  already_executed: 409,
  playbook_scope: 403,
  partner_unavailable: 503,
  partner_error: 502,
  not_found: 404,
};

export class GatewayError extends Error {
  constructor(
    public readonly code: GatewayDenyCode,
    message: string,
  ) {
    super(message);
  }
}
