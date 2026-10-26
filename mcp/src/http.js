/* Streamable HTTP for the same tools, stateless: every POST gets a fresh McpServer and transport,
   answers in plain JSON (no SSE stream, no session id), and both are closed with the response.
   The caller does authentication and picks the profile (state.configure) before handing over. */
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createServer } from './server.js'

export { configure } from './state.js'

/** Serve one MCP request. `body` is the already-parsed JSON-RPC message (or batch). */
export async function handleMcpRequest(req, res, body) {
  const server = createServer()
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.on('close', () => { transport.close(); server.close() })
  await server.connect(transport)
  await transport.handleRequest(req, res, body)
}
