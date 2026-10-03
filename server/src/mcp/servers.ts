import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';
import { GatewayError } from './errors';
import { TOOL_DEFINITIONS, type McpServer as ServerId } from './tools';

// Partner-side MCP servers (simulated), one per standard contract. Each runs the same handlers the
// production partner would expose; Saathi reaches them only through its gateway (an MCP client).
export const PARTNER_SERVERS: Exclude<ServerId, 'identity'>[] = ['insurer', 'hospital', 'payments', 'lender', 'aa', 'crm', 'bureau', 'knowledge'];

export const CONTRACT_NAMES: Record<Exclude<ServerId, 'identity'>, string> = {
  insurer: 'insurer.v1',
  hospital: 'provider.v1',
  payments: 'payments.v1',
  lender: 'lender.v1',
  aa: 'aa.v1',
  crm: 'crm.v1',
  bureau: 'bureau.v1',
  knowledge: 'knowledge.v1',
};

const ERROR_PREFIX = 'GATEWAY:';

export function encodeGatewayError(error: GatewayError): string {
  return `${ERROR_PREFIX}${error.code}:${error.message}`;
}

export function decodeGatewayError(text: string): GatewayError | null {
  if (!text.startsWith(ERROR_PREFIX)) return null;
  const rest = text.slice(ERROR_PREFIX.length);
  const split = rest.indexOf(':');
  return new GatewayError(rest.slice(0, split) as GatewayError['code'], rest.slice(split + 1));
}

export function createPartnerServer(server: Exclude<ServerId, 'identity'>, fallbackCustomerId?: string): McpServer {
  const mcp = new McpServer(
    { name: CONTRACT_NAMES[server], version: '1.0.0' },
    {
      instructions:
        'Simulated Paytm Saathi partner server. Read tools return sample records; write tools are called by the ' +
        'Saathi gateway only after a verified, payload-bound customer approval.',
    },
  );
  for (const tool of TOOL_DEFINITIONS.filter((definition) => definition.server === server)) {
    mcp.registerTool(
      tool.name,
      {
        title: tool.name,
        description: `${tool.description}${tool.kind === 'write' ? ' Write tool: requires a customer approval at the Saathi gateway.' : ''}`,
        inputSchema: (tool.input as unknown as z.AnyZodObject).shape,
        annotations: { readOnlyHint: tool.kind === 'read', destructiveHint: false, openWorldHint: false },
      },
      async (args: Record<string, unknown>, extra: { _meta?: Record<string, unknown> }) => {
        const customerId = String(extra._meta?.customer_id ?? fallbackCustomerId ?? '');
        if (!customerId) throw new Error(`${ERROR_PREFIX}invalid_input:Missing customer context (_meta.customer_id).`);
        try {
          const result = tool.handler({ customer_id: customerId }, args);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: { result } };
        } catch (error) {
          if (error instanceof GatewayError) throw new Error(encodeGatewayError(error));
          throw error;
        }
      },
    );
  }
  return mcp;
}
