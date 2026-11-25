// The real tools over stdio, with a fake hearthis.at behind them: every call answers after FAKE_DELAY_MS and gives up
// when the request's signal aborts. Used by test/protocol.mjs - no network, no account.
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { requestContext } from '../dist/client.js';
import { registerTools } from '../dist/tools.js';

const delay = Number(process.env.FAKE_DELAY_MS ?? 0);
const answer = () => new Promise((resolve, reject) => {
  const signal = requestContext.getStore()?.signal;
  const timer = setTimeout(() => resolve({ id: '1', permalink: 'fake', premium: true }), delay);
  signal?.addEventListener('abort', () => {
    clearTimeout(timer);
    process.stderr.write('fake-server: request aborted\n');
    reject(new Error('aborted'));
  });
});
const api = { ensurePremium: async () => ({ permalink: 'fake' }), get: answer, post: answer, scrub: (text) => text };

serveStdio(() => {
  const server = new McpServer({ name: 'hearthis', version: 'fake' });
  registerTools(server, api);
  return server;
});
