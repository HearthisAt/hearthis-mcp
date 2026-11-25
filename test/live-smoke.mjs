// Live smoke test against hearthis.at, read-only tools only - once per protocol era: a 2026-07-28 client (server/discover,
// _meta per request) and a 2025 client (initialize handshake, the v1 SDK).
// node test/live-smoke.mjs <env-file with HEARTHIS_TEST_EMAIL / HEARTHIS_TEST_PASSWORD>
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport as LegacyStdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const env = Object.fromEntries(fs.readFileSync(process.argv[2], 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l))
  .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, '')]; }));
const login = await fetch('https://api-v2.hearthis.at/login/', {
  method: 'POST',
  headers: { 'User-Agent': 'hearthis-mcp-test/0', 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ email: env.HEARTHIS_TEST_EMAIL, password: env.HEARTHIS_TEST_PASSWORD }),
}).then((r) => r.json());
console.log('login premium:', login.premium, 'key present:', Boolean(login.key && login.secret));

const params = {
  command: process.execPath,
  args: [new URL('../dist/index.js', import.meta.url).pathname],
  env: { ...process.env, HEARTHIS_KEY: login.key, HEARTHIS_SECRET: login.secret },
  stderr: 'inherit',
};
const eras = [
  ['2026-07-28', new Client({ name: 'smoke', version: '0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } }), new StdioClientTransport(params)],
  ['2025 legacy', new LegacyClient({ name: 'smoke-legacy', version: '0' }), new LegacyStdioClientTransport(params)],
];
for (const [era, client, transport] of eras) {
  await client.connect(transport);
  console.log(`--- ${era}: protocol ${client.getNegotiatedProtocolVersion?.() ?? 'initialize handshake'}, server ${JSON.stringify(client.getServerVersion())}`);
  const { tools } = await client.listTools();
  console.log('tools:', tools.length, tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name).join(','));
  const calls = [
    ['whoami', {}],
    ['get_feed', { count: 2 }],
    ['search', { type: 'tracks', query: 'techno', count: 2 }],
    ['get_home_section', { section: 'genres_today', count: 3 }],
    ['list_genres', {}],
    ['list_my_sets', { count: 2 }],
    ['get_group', { group_id: 1, part: 'info' }],
    ['get_track', { author: '../etc', track: 'x' }],
  ];
  for (const [name, args] of calls) {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content?.[0]?.text ?? '';
    const leak = /"(key|secret|masterkeystore)"/.test(text) && name === 'whoami';
    console.log(result.isError ? 'ERR' : 'ok ', name.padEnd(18), text.length, leak ? 'LEAK' : '', text.slice(0, 140).replace(/\s+/g, ' '));
  }
  await client.close();
}
