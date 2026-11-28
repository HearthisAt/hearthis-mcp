// Offline test of the sign-in with a personal API key (HEARTHIS_API_KEY): which credentials the environment gives, that
// the key travels only as a Bearer header, how /oauth/userinfo/ becomes the account, which tools a key is offered and
// how the refusals of the API read. fetch is replaced - no network, no account.
// npm run build && node test/api-key.mjs
import { credentialsFromEnv, HearthisClient } from '../dist/client.js';
import { registerTools } from '../dist/tools.js';

let failed = 0;
const check = (ok, label) => {
  console.log(ok ? 'ok  ' : 'FAIL', label);
  failed += ok ? 0 : 1;
};
const KEY = 'htp_' + 'a'.repeat(40);

check(credentialsFromEnv({ HEARTHIS_API_KEY: ` ${KEY} ` }).kind === 'token', 'HEARTHIS_API_KEY signs in as a key');
check(credentialsFromEnv({ HEARTHIS_KEY: 'k', HEARTHIS_SECRET: 's' }).kind === 'pair', 'the key pair still signs in');
check(credentialsFromEnv({ HEARTHIS_API_KEY: KEY, HEARTHIS_KEY: 'k', HEARTHIS_SECRET: 's' }).kind === 'token', 'the API key wins over the pair');
check(credentialsFromEnv({ HEARTHIS_KEY: KEY }).kind === 'token', 'a key pasted into HEARTHIS_KEY is a key');
check(credentialsFromEnv({ HEARTHIS_API_KEY: 'htp_short' }).kind === 'none', 'a malformed key is refused at start');
check(credentialsFromEnv({ HEARTHIS_KEY: 'k' }).kind === 'none', 'half a pair is nothing');

const calls = [];
let answer = () => ({ status: 200, body: {} });
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init });
  const { status, body, headers = {} } = answer(String(url), init);
  return new Response(JSON.stringify(body), { status, headers });
};
const userinfo = (scope) => ({ sub: '7', id: 7, username: 'djname', name: 'DJ Name', premium: true, scope });

{
  const api = new HearthisClient({ kind: 'token', token: KEY }, 'hearthis-mcp/test');
  answer = (url) => (url.includes('/oauth/userinfo/') ? { status: 200, body: userinfo('profile read social') } : { status: 200, body: [] });
  const account = await api.ensurePremium();
  check(account.id === 7 && account.permalink === 'djname' && account.username === 'DJ Name', 'userinfo becomes the account');
  check(account.scopes?.join(' ') === 'profile read social', 'with the rights of the key');
  await api.get('/feed/', { count: 2 });
  await api.post('/djname/mix/comment/', { comment: 'x' });
  const sent = calls.map(({ url, init }) => url + ' ' + String(init.body ?? ''));
  check(calls.every(({ init }) => init.headers.Authorization === `Bearer ${KEY}`), 'every request carries the Bearer header');
  check(sent.every((text) => !/key=|secret=/.test(text) && !text.includes(KEY)), 'and neither key nor secret in address or body');
  check(calls.every(({ url }) => new URL(url).origin === 'https://api-v2.hearthis.at'), 'only to the API host');

  const refused = (access) => {
    try {
      api.ensureAccess(access, account);
      return '';
    } catch (error) {
      return `${error.code}: ${error.message}`;
    }
  };
  check(refused('read') === '' && refused('social') === '', 'read and social tools go on');
  check(/^insufficient_scope: .*"Upload and edit" \(write\)/.test(refused('write')), 'a write tool names the missing right before any request');
  check(/^not_available: /.test(refused('pair')), 'what no key reaches says so');
  check(/^insufficient_scope: .*"Messages" \(messages\)/.test(refused('messages')), 'messages need their own right');
  check(api.scrub(`x ${KEY} y`) === 'x [redacted] y', 'the key never leaves in a text');

  const failure = async (status, body) => {
    answer = () => ({ status, body });
    return api.get('/feed/').then(() => 'answered', (error) => `${error.status} ${error.code}: ${error.message}`);
  };
  check(/^401 invalid_credentials: .*HEARTHIS_API_KEY/.test(await failure(401, { success: false, error: 'invalid_token' })), 'a revoked key reads as such');
  check(/^403 insufficient_scope: .*\(social\)/.test(await failure(403, { success: false, error: 'insufficient_scope', scope: 'social' })), 'insufficient_scope of the API names the right');
  check(/^403 not_available: /.test(await failure(403, { success: false, error: 'not_available' })), 'not_available of the API is explained');
  check(/^403 premium_required: /.test(await failure(403, { success: false, code: 'premium_required' })), 'premium_required stays what it was');
}

{
  calls.length = 0;
  const api = new HearthisClient({ kind: 'pair', key: 'thekey123', secret: 'thesecret456' }, 'hearthis-mcp/test');
  answer = () => ({ status: 200, body: { id: '7', permalink: 'djname', username: 'DJ Name', premium: true } });
  const account = await api.ensurePremium();
  api.ensureAccess('pair', account);
  check(account.permalink === 'djname' && account.scopes === undefined, 'the pair reads /login/ and has no scopes');
  check(calls.every(({ url, init }) => url.includes('key=thekey123') && url.includes('secret=thesecret456') && !('Authorization' in init.headers)), 'the pair travels as before, without a Bearer header');
}

const offered = (mode) => {
  const names = [];
  registerTools({ registerTool: (name) => names.push(name) }, { mode });
  return names;
};
const all = offered('pair');
const forKey = offered('token');
const hidden = all.filter((name) => !forKey.includes(name));
check(all.length === 75, `the pair is offered every tool (${all.length})`);
check(
  hidden.sort().join(',') === 'delete_conversation',
  `a key is not offered what the API never opens to keys (${hidden.join(', ')})`,
);
check(['list_workflows', 'add_feed', 'delete_group', 'upload_track', 'whoami', 'get_account_stats', 'get_track_stats', 'get_faq'].every((name) => forKey.includes(name)), 'workflows, feed sync, groups, uploads, statistics and the FAQ are offered to a key');
check(['get_link_page', 'edit_link_page', 'get_link_page_stats'].every((name) => forKey.includes(name)), 'and the link page');

// The link page tools as a client calls them: what goes to the API, what comes back, what never leaves
{
  const handlers = {};
  const api = new HearthisClient({ kind: 'token', token: KEY }, 'hearthis-mcp/test');
  registerTools({ registerTool: (name, config, handler) => { handlers[name] = handler; } }, api);
  const run = async (name, args) => {
    const result = await handlers[name](args, { mcpReq: { _meta: {}, signal: undefined, notify: async () => {} } });
    return { error: result.isError === true, text: result.content[0].text };
  };
  const linkpage = { available: true, url: 'https://hearthis.at/@djname/', sound_mode: 'play', links: [{ key: 'instagram', type: 'instagram', title: 'Instagram', url: 'https://instagram.com/x', visible: true }], tracks: [], sets: [] };
  answer = (url, init) => {
    if (url.includes('/oauth/userinfo/')) {
      return { status: 200, body: userinfo('profile read write') };
    }
    if (url.includes('/my/linkpage/stats/')) {
      return { status: 404, body: { success: false, code: 'no_linkpage' } };
    }
    return { status: 200, body: init.method === 'POST' ? linkpage : { id: 7, permalink: 'djname', linkpage } };
  };

  calls.length = 0;
  const read = await run('get_link_page', {});
  check(!read.error && read.text === JSON.stringify(linkpage), 'get_link_page answers the link page of the own profile');
  check(new URL(calls.at(-1).url).pathname === '/djname/', 'read from the own profile object');

  const saved = await run('edit_link_page', {
    links: [{ key: 'instagram', visible: false }, { key: 'custom', title: 'Shop', url: 'https://example.com/shop' }, { url: 'https://example.com/tour' }, { key: 'facebook' }],
    tracks: [12, 34],
    sets: [],
  });
  const sent = calls.at(-1);
  const body = new URLSearchParams(String(sent.init.body));
  check(!saved.error && sent.init.method === 'POST' && new URL(sent.url).pathname === '/my/linkpage/', 'edit_link_page posts to /my/linkpage/');
  check(
    body.get('links') === JSON.stringify([{ key: 'instagram', visible: false }, { title: 'Shop', url: 'https://example.com/shop' }, { title: '', url: 'https://example.com/tour' }, { key: 'facebook', visible: true }]),
    'profile links go as key and visible, own links as title and url',
  );
  check(body.get('tracks') === '[12,34]' && body.get('sets') === '[]' && !body.has('sound_mode'), 'lists go as JSON, an empty one too, and what was not given is not sent');

  {
    const mine = { ...linkpage, links: [...linkpage.links, { key: 'custom', type: 'custom', title: 'Shop', url: 'https://example.com/shop', visible: true }] };
    const usual = answer;
    answer = (url, init) => (init.method === 'POST' ? { status: 200, body: mine } : usual(url, init));
    const partly = JSON.parse((await run('edit_link_page', { links: [{ key: 'instagram' }, { key: 'shop', title: 'Shop' }, { url: 'https://example.com/shop' }, { url: 'ftp://example.com/x' }] })).text);
    check(partly.not_saved?.unknown_keys?.join() === 'shop' && partly.not_saved?.own_links === 1 && partly.links.length === 2, 'what the API left out is named: an unknown key, an own link it did not take');
    const whole = await run('edit_link_page', { links: mine.links });
    check(!whole.error && !whole.text.includes('not_saved') && JSON.parse(whole.text).links.length === 2, 'an answer that holds every sent entry carries no note');
    answer = usual;
  }

  const before = calls.length;
  for (const [args, words] of [
    [{}, /links, tracks, sets or sound_mode/],
    [{ links: [{ title: 'No address' }] }, /links\[0\] needs/],
    [{ links: [{ key: 'instagram' }, { url: 'https://example.com/', visible: false }] }, /links\[1\] is an own link/],
  ]) {
    const refused = await run('edit_link_page', args);
    check(refused.error && words.test(refused.text), `refused before any request: ${refused.text.slice(0, 50)}`);
  }
  check(calls.length === before, 'nothing of that reached the API');

  const stats = await run('get_link_page_stats', { days: 7 });
  check(stats.error && /no link page yet/.test(stats.text) && new URL(calls.at(-1).url).searchParams.get('days') === '7', 'statistics of an account without a link page say so');

  const readOnly = new HearthisClient({ kind: 'token', token: KEY }, 'hearthis-mcp/test');
  answer = (url) => ({ status: 200, body: url.includes('/oauth/userinfo/') ? userinfo('profile read') : {} });
  registerTools({ registerTool: (name, config, handler) => { handlers[name] = handler; } }, readOnly);
  calls.length = 0;
  const denied = await run('edit_link_page', { sound_mode: 'open' });
  check(denied.error && /"Upload and edit" \(write\)/.test(denied.text) && !calls.some(({ url }) => url.includes('/my/linkpage/')), 'a key without write never posts the link page');
}

process.exitCode = failed ? 1 : 0;
