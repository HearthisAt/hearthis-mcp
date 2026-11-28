// Live test of the sign-in with a personal API key against hearthis.at: makes two keys for the test account over the
// API (all rights, and read only), runs the server with each, calls read-only tools and revokes both keys at the end.
// node test/live-key.mjs <env-file with HEARTHIS_TEST_EMAIL / HEARTHIS_TEST_PASSWORD>
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const API = 'https://api-v2.hearthis.at';
const UA = { 'User-Agent': 'hearthis-mcp-test/0' };
const SERVER = new URL('../dist/index.js', import.meta.url).pathname;
const env = Object.fromEntries(fs.readFileSync(process.argv[2], 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l))
  .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, '')]; }));

let failed = 0;
const check = (ok, label) => {
  console.log(ok ? 'ok  ' : 'FAIL', label);
  failed += ok ? 0 : 1;
};

const login = await fetch(API + '/login/', {
  method: 'POST',
  headers: { ...UA, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ email: env.HEARTHIS_TEST_EMAIL, password: env.HEARTHIS_TEST_PASSWORD }),
}).then((r) => r.json());
const pair = new URLSearchParams({ key: login.key, secret: login.secret });
const makeKey = async (scopes) => {
  const response = await fetch(`${API}/api-keys/?${pair}`, {
    method: 'POST',
    headers: { ...UA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `hearthis-mcp test ${scopes.join('+')} ${Date.now()}`, scopes, expires_in_days: 30 }),
  });
  const body = await response.json();
  if (response.status !== 201) {
    throw new Error(`no key: ${response.status} ${JSON.stringify(body)}`);
  }
  return body.key;
};
const revoke = (key) => fetch(`${API}/api-keys/${key.id}/?${pair}`, { method: 'POST', headers: UA }).then((r) => r.status);
const connect = async (token) => {
  // No inherited credentials: the key alone signs in
  const { HEARTHIS_KEY, HEARTHIS_SECRET, ...clean } = process.env;
  const client = new Client({ name: 'live-key', version: '0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...clean, HEARTHIS_API_KEY: token }, stderr: 'inherit' }));
  return client;
};
const call = async (client, name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  return { error: Boolean(result.isError), text: result.content?.[0]?.text ?? '' };
};
const runLogin = (input) => new Promise((resolve) => {
  const { HEARTHIS_KEY, HEARTHIS_SECRET, HEARTHIS_API_KEY, ...clean } = process.env;
  const child = spawn(process.execPath, [SERVER, 'login'], { env: clean });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { out += chunk; });
  child.on('close', (code) => resolve({ code, out }));
  child.stdin.end(input + '\n');
});

const keys = [];
try {
  const full = await makeKey(['read', 'social', 'write', 'messages']);
  keys.push(full);
  const readOnly = await makeKey(['read']);
  keys.push(readOnly);

  {
    const client = await connect(full.token);
    const { tools } = await client.listTools();
    check(tools.length === 74 && !tools.some((t) => t.name === 'delete_conversation'), `a key is offered every tool but delete_conversation (${tools.length})`);
    const who = await call(client, 'whoami');
    check(!who.error && who.text.includes(`"permalink":"${login.permalink}"`) && who.text.includes('"premium":true') && who.text.includes('"scopes":["profile","read","social","write","messages"]'), 'whoami reads the account of the key');
    check(!who.text.includes(full.token) && !/"(secret|masterkeystore)"/.test(who.text), 'no credential in the answer');
    for (const [name, args, field] of [
      ['get_feed', { count: 2 }, 'permalink'],
      ['list_my_sets', { count: 2 }, ''],
      ['get_fan_subscriptions', {}, ''],
      ['list_workflows', {}, '"workflows"'],
      ['get_workflow_run', {}, '"runs"'],
      ['list_control_tags', {}, '"control_tags"'],
      ['list_feeds', {}, '"feeds"'],
      ['workflow_webhook', { action: 'show' }, 'signature'],
      ['get_account_stats', { days: 7 }, '"totals"'],
      ['get_link_page', {}, '"visible"'],
      ['get_link_page_stats', { days: 7 }, '"opens"'],
      ['get_faq', { id: '70' }, 'hearthis-mcp'],
      ['get_faq', { query: 'upload limit', count: 2 }, '"hits"'],
      ['get_faq', { lang: 'de' }, '"topics"'],
      ['list_conversations', {}, '"conversations"'],
      ['poll_messages', { since: 4000000000 }, '"messages"'],
    ]) {
      const result = await call(client, name, args);
      check(!result.error && result.text.includes(field), `${name} answers (${result.text.slice(0, 90).replace(/\s+/g, ' ')})`);
    }
    const group = await call(client, 'delete_group', { group_id: 999999999 });
    check(!/API key/.test(group.text), `delete_group reaches the API with a key - the group does not exist (${group.text.slice(0, 80)})`);
    await client.close();
  }

  {
    const client = await connect(readOnly.token);
    const feed = await call(client, 'get_feed', { count: 1 });
    check(!feed.error, 'a read-only key reads the feed');
    const like = await call(client, 'toggle_like', { author: login.permalink, track: 'not-a-sound-of-the-test' });
    check(like.error && /"Likes, follows and comments" \(social\)/.test(like.text), 'and is told which right a like needs');
    const workflows = await call(client, 'list_workflows');
    check(workflows.error && /"Upload and edit" \(write\)/.test(workflows.text), 'workflows need write, reading too');
    const inbox = await call(client, 'list_conversations');
    check(inbox.error && /"Messages" \(messages\)/.test(inbox.text), 'messages need their own right');
    const faq = await call(client, 'get_faq', { id: '70' });
    check(!faq.error && faq.text.includes('"question"'), 'the FAQ needs no right');
    const page = await call(client, 'get_link_page', {});
    check(!page.error && page.text.includes('"visible"'), 'a read-only key reads the link page as its owner');
    const edit = await call(client, 'edit_link_page', { sound_mode: 'play' });
    check(edit.error && /"Upload and edit" \(write\)/.test(edit.text), 'and is told which right changing it needs');
    const stats = await call(client, 'get_account_stats', {});
    check(!stats.error && stats.text.includes('"period"'), 'a read-only key reads the statistics');
    const quality = await call(client, 'streaming_quality', { author: login.permalink, track: 'not-a-sound-of-the-test', value: 'best' });
    check(quality.error && /\(write\)/.test(quality.text), `a refusal of the API itself names the right (${quality.text.slice(0, 80)})`);
    await client.close();
  }

  {
    const shown = await runLogin(full.token);
    check(shown.code === 0 && shown.out.includes(`HEARTHIS_API_KEY=${full.token}`) && shown.out.includes('read, social, write, messages'), 'login takes a key and prints its configuration');
    const unknown = await runLogin('htp_' + 'x'.repeat(40));
    check(unknown.code === 1 && /does not know this API key/.test(unknown.out), 'login says when hearthis.at does not know the key');
    const malformed = await runLogin('htp_short');
    check(malformed.code === 1 && /no hearthis\.at API key/.test(malformed.out), 'and when it is none');
  }
} finally {
  for (const key of keys) {
    check((await revoke(key)) === 200, `key ${key.id} revoked`);
  }
}
if (keys[0]) {
  const client = await connect(keys[0].token);
  const after = await call(client, 'whoami');
  check(after.error && /HEARTHIS_API_KEY/.test(after.text) && !after.text.includes(keys[0].token), 'a revoked key is refused with a readable message');
  await client.close();
}
process.exitCode = failed ? 1 : 0;
