import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { settings } from '../config';
import { GatewayError } from './errors';
import { CONTRACT_NAMES, createPartnerServer, decodeGatewayError, PARTNER_SERVERS } from './servers';
import type { McpServer as ServerId } from './tools';

type PartnerId = Exclude<ServerId, 'identity'>;

// The gateway is an MCP client with one connection per partner server. By default the simulated partner
// runs in-process; set MCP_URL_<SERVER> (for example MCP_URL_INSURER) to reach a remote Streamable HTTP
// server instead. Swapping in a partner's real server is a URL change.
const connections = new Map<PartnerId, Promise<Client>>();

export function partnerUrl(server: PartnerId): string | null {
  return process.env[`MCP_URL_${server.toUpperCase()}`]?.trim() || null;
}

async function connect(server: PartnerId): Promise<Client> {
  const client = new Client({ name: 'saathi-gateway', version: '1.0.0' });
  const url = partnerUrl(server);
  if (url) {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${settings.mcpPartnerToken}` } },
      }),
    );
  } else {
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await createPartnerServer(server).connect(serverSide);
    await client.connect(clientSide);
  }
  return client;
}

function clientFor(server: PartnerId): Promise<Client> {
  let connection = connections.get(server);
  if (!connection) {
    connection = connect(server).catch((error) => {
      connections.delete(server);
      throw error;
    });
    connections.set(server, connection);
  }
  return connection;
}

export async function callPartnerTool<T>(
  server: PartnerId,
  name: string,
  input: Record<string, unknown>,
  meta: { customer_id: string; case_id: string },
): Promise<T> {
  let response: Awaited<ReturnType<Client['callTool']>>;
  try {
    const client = await clientFor(server);
    response = await client.callTool({ name, arguments: input, _meta: meta });
  } catch (error) {
    throw new GatewayError('partner_unavailable', `${CONTRACT_NAMES[server]} is unreachable: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  const text = Array.isArray(response.content) && response.content[0]?.type === 'text' ? String(response.content[0].text) : '';
  if (response.isError) throw decodeGatewayError(text) ?? new GatewayError('partner_error', text || `${name} failed.`);
  const structured = response.structuredContent as { result?: T } | undefined;
  return (structured && 'result' in structured ? structured.result : JSON.parse(text)) as T;
}

export function partnerServerCatalog() {
  return PARTNER_SERVERS.map((server) => ({
    server,
    contract: CONTRACT_NAMES[server],
    transport: partnerUrl(server) ? 'streamable_http' : 'in_process',
    remote_url: partnerUrl(server),
    http_endpoint: `/mcp/${server}`,
  }));
}
