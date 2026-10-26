/* The openGym MCP server, transport-agnostic: a set of tools registered on one McpServer.
   index.js connects it to stdio with the read tools and the write tool (log_workout); http.js
   to a Streamable HTTP request (the api's /api/mcp route) with the read-only tools alone, which
   is the default here. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { TOOLS } from './tools.js'

export function createServer({ tools = TOOLS } = {}) {
  const server = new McpServer({ name: 'opengym', version: '0.1.0' })
  for (const t of tools) {
    server.tool(
      t.name,
      t.description,
      t.schema,
      async (params) => {
        try {
          // log_workout talks to the server, so a handler may answer with a promise.
          const result = await t.handler(params || {})
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
        } catch (err) {
          const code = err.code || 'ERROR'
          return {
            isError: true,
            content: [{ type: 'text', text: `${code}: ${err.message}` }]
          }
        }
      }
    )
  }
  return server
}
