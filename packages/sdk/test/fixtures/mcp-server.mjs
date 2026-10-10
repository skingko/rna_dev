import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin });
let initialized = false;
const send = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
input.on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send(message.id, { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'rna-test-fixture', version: '1' } });
  else if (message.method === 'notifications/initialized') initialized = true;
  else if (message.method === 'tools/list') send(message.id, { tools: [{ name: 'echo', description: 'Echo test text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }, { name: 'unapproved_write', inputSchema: { type: 'object' } }] });
  else if (message.method === 'tools/call' && message.params.name === 'echo') send(message.id, { content: [{ type: 'text', text: `${initialized ? 'initialized:' : 'bad:'}${message.params.arguments.text}` }] });
  else if (message.method === 'hang') {}
  else if (message.method === 'notifications/cancelled') send(message.params.requestId, { cancelled: true });
});
