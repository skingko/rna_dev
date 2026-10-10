import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityRegistry } from '../src/capabilities.mjs';
import { McpError } from '../src/mcp.mjs';

// A definite MCP failure is an ordinary tool error; only a lost transport on a mutating tool stays uncertain.
function registry(failure) {
  const client = { ready: true, closed: false, async connect() {}, async listTools() { return ['observe', 'mutate'].map(name => ({ name, inputSchema: { type: 'object' } })); }, async callTool() { throw failure; }, async close() {} };
  const reg = new CapabilityRegistry({ mcpServers: [{ id: 'srv', transport: 'stdio', command: 'x', allowTools: { observe: { permission: 'read' }, mutate: { permission: 'exec' } }, enabled: true, trusted: true }], clientFactory: () => client });
  return reg;
}
const tool = async (reg, raw) => { await reg.connectMcp('srv'); return [...reg.tools.values()].find(row => row.rawName === raw); };

test('a JSON-RPC error or an unsent request is returned as a tool error, not thrown', async () => {
  for (const code of ['remote_error', 'not_ready']) {
    const result = await (await tool(registry(new McpError('refused', code)), 'mutate')).execute('c', {});
    assert.equal(result.isError, true); assert.match(result.content[0].text, new RegExp(code));
  }
});
test('a read tool failure is an ordinary error even when the transport failed', async () => {
  const result = await (await tool(registry(new McpError('pipe closed', 'transport_closed')), 'observe')).execute('c', {});
  assert.equal(result.isError, true);
});
test('a lost transport on a mutating tool still throws, so the session can mark it uncertain', async () => {
  await assert.rejects((await tool(registry(new McpError('pipe closed', 'transport_closed')), 'mutate')).execute('c', {}), { code: 'transport_closed' });
});
