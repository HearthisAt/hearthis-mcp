// Offline protocol test, both eras (2026-07-28 and the 2025 initialize handshake): a slow call sends progress every 10 s,
// and a cancelled call aborts its request. Runs the real tools against test/fake-server.mjs (about 40 s).
// npm run build && node test/protocol.mjs
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport as LegacyStdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const params = (delay) => ({
  command: process.execPath,
  args: [new URL('./fake-server.mjs', import.meta.url).pathname],
  env: { ...process.env, FAKE_DELAY_MS: String(delay) },
  stderr: 'pipe',
});
const eras = [
  ['2026-07-28', (delay) => [new Client({ name: 'protocol', version: '0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } }), new StdioClientTransport(params(delay))]],
  ['2025 legacy', (delay) => [new LegacyClient({ name: 'protocol', version: '0' }), new LegacyStdioClientTransport(params(delay))]],
];
// callTool(params, options) in the v2 client, callTool(params, resultSchema, options) in v1
const callTool = (era, client, options) =>
  era === '2025 legacy' ? client.callTool({ name: 'whoami', arguments: {} }, undefined, options) : client.callTool({ name: 'whoami', arguments: {} }, options);

let failed = 0;
const check = (ok, label) => {
  console.log(ok ? 'ok  ' : 'FAIL', label);
  failed += ok ? 0 : 1;
};

for (const [era, make] of eras) {
  {
    const [client, transport] = make(11_000);
    await client.connect(transport);
    const beats = [];
    const result = await callTool(era, client, { onprogress: (progress) => beats.push(progress), timeout: 30_000 });
    check(!result.isError && /"permalink":\s*"fake"/.test(result.content?.[0]?.text ?? ''), `${era}: slow call answers`);
    check(beats.length === 1 && beats[0].progress === 1, `${era}: one progress beat after 10 s (${JSON.stringify(beats)})`);
    await client.close();
  }
  {
    const [client, transport] = make(60_000);
    let log = '';
    await client.connect(transport);
    transport.stderr?.on('data', (chunk) => { log += chunk; });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1_000);
    const outcome = await callTool(era, client, { signal: controller.signal, timeout: 30_000 })
      .then(() => 'answered', (error) => error.name ?? 'error');
    await new Promise((resolve) => setTimeout(resolve, 500));
    check(outcome !== 'answered', `${era}: cancelled call rejects at the client (${outcome})`);
    check(log.includes('request aborted'), `${era}: cancelled call aborts the request on the server`);
    await client.close();
  }
}
process.exitCode = failed ? 1 : 0;
