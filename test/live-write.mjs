// Live test of the writing tools against hearthis.at - only reversible changes on the test account (unpublished content,
// plus the caption of its profile), every change turned back in the same run. Nothing is created that would need deleting: hearthis.at
// has no staging, and test content is never deleted (no upload, no new set or group, no delete tools, no follow,
// no messages, no comments, no likes).
// node test/live-write.mjs <env file with HEARTHIS_TEST_EMAIL / HEARTHIS_TEST_PASSWORD of a Premium account>
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const env = Object.fromEntries(fs.readFileSync(process.argv[2], 'utf8').split('\n').filter((line) => /^[A-Z_]+=/.test(line))
  .map((line) => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1).replace(/^["']|["']$/g, '')]; }));
const login = await fetch('https://api-v2.hearthis.at/login/', {
  method: 'POST',
  headers: { 'User-Agent': 'hearthis-mcp-test/0', 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ email: env.HEARTHIS_TEST_EMAIL, password: env.HEARTHIS_TEST_PASSWORD }),
}).then((response) => response.json());

const client = new Client({ name: 'live-write', version: '0' });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [new URL('../dist/index.js', import.meta.url).pathname],
  env: { ...process.env, HEARTHIS_KEY: login.key, HEARTHIS_SECRET: login.secret },
}));

let failed = 0;
const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text ?? '';
  if (text.includes(login.key) || text.includes(login.secret)) {
    throw new Error(`${name} returned the key pair`);
  }
  if (result.isError) {
    throw new Error(`${name}: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
const check = (label, ok, detail = '') => {
  console.log(ok ? 'ok  ' : 'FAIL', label, detail);
  if (!ok) {
    failed++;
  }
};

const me = await call('whoami', {});
check('whoami is Premium', me.premium === true, me.permalink);

let own = null;
for (let page = 1; page <= 5 && !own; page++) {
  const list = await call('get_user', { author: me.permalink, list: 'tracks', page, count: 50 });
  own = (Array.isArray(list) ? list : []).find((track) => String(track.private) === '1');
}
if (!own) {
  console.log('No unpublished track of the test account found - stopping.');
  process.exit(1);
}
const author = me.permalink;
console.log('test track:', own.id, own.permalink, '(private)');

// 1. edit_track: description changed and restored
{
  const before = await call('get_track', { author, track: own.permalink });
  check('track is private before', String(before.private) === '1');
  const original = before.description ?? '';
  // The API trims the description: no leading space when the original is empty
  const marker = (original + ' [mcp-live-test]').trim();
  await call('edit_track', { track_id: Number(own.id), description: marker });
  const changed = await call('get_track', { author, track: own.permalink });
  check('edit_track changed the description', changed.description === marker);
  check('edit_track left the track private', String(changed.private) === '1');
  await call('edit_track', { track_id: Number(own.id), description: original });
  const restored = await call('get_track', { author, track: own.permalink });
  check('description restored', (restored.description ?? '') === original);
}

// 2. streaming_quality: read only (no value)
{
  const quality = await call('streaming_quality', { author, track: own.permalink });
  check('streaming_quality answers', quality && typeof quality === 'object', JSON.stringify(quality).slice(0, 80));
}

// 3. set_listen_later: someone else's public track saved and removed
{
  const later = await call('get_listen_later', { count: 100 });
  const known = new Set((Array.isArray(later) ? later : []).map((track) => String(track.id)));
  const feed = await call('get_feed', { count: 10 });
  const foreign = feed.find((track) => track.user?.permalink !== author && !known.has(String(track.id)));
  await call('set_listen_later', { author: foreign.user.permalink, track: foreign.permalink, on: true });
  const saved = await call('get_listen_later', { count: 100 });
  check('set_listen_later saved', saved.some((track) => String(track.id) === String(foreign.id)));
  await call('set_listen_later', { author: foreign.user.permalink, track: foreign.permalink, on: false });
  const removed = await call('get_listen_later', { count: 100 });
  check('set_listen_later removed again', !removed.some((track) => String(track.id) === String(foreign.id)));
}

// 4. add_to_set / remove_from_set: the private track into a private own set and out again
{
  const sets = await call('list_my_sets', { count: 50 });
  const set = (Array.isArray(sets) ? sets : []).find((entry) => String(entry.privat) === '1' && String(entry.user_id) === String(me.id));
  if (!set) {
    check('private own set found', false);
  } else {
    const tracksBefore = await call('get_set', { permalink: set.permalink });
    const list = (value) => (Array.isArray(value) ? value : value?.tracks ?? []);
    if (list(tracksBefore).some((track) => String(track.id) === String(own.id))) {
      check('test track not yet in the set', false, set.permalink);
    } else {
      await call('add_to_set', { track_id: Number(own.id), set_id: Number(set.id) });
      const added = await call('get_set', { permalink: set.permalink });
      check('add_to_set added', list(added).some((track) => String(track.id) === String(own.id)), set.permalink);
      await call('remove_from_set', { set_id: Number(set.id), track_id: Number(own.id) });
      const after = await call('get_set', { permalink: set.permalink });
      check('remove_from_set removed again', !list(after).some((track) => String(track.id) === String(own.id)));
      check('set has its old length', list(after).length === list(tracksBefore).length, `${list(after).length}`);
    }
  }
}

// 5. badge_settings: written with the values it already has
{
  const badges = await call('get_user', { author, list: 'badges' });
  const settings = badges.settings ?? badges;
  if (settings.badges_public === undefined || settings.email_badges === undefined) {
    check('badge settings readable', false, JSON.stringify(badges).slice(0, 120));
  } else {
    const isOn = (value) => value === true || Number(value) === 1;
    await call('badge_settings', { badges_public: isOn(settings.badges_public), email_badges: isOn(settings.email_badges) });
    const after = await call('get_user', { author, list: 'badges' });
    const now = after.settings ?? after;
    check('badge_settings kept the values', isOn(now.badges_public) === isOn(settings.badges_public) && isOn(now.email_badges) === isOn(settings.email_badges));
  }
}

// 6. edit_profile: the caption changed and restored, the e-mail never reaches the profile
{
  const before = await call('get_user', { author });
  const caption = String(before.caption ?? '');
  let restored = false;
  try {
    const saved = await call('edit_profile', { caption: (caption + ' [mcp-live-test]').slice(0, 100) });
    check('edit_profile changed the caption', saved.user?.caption === (caption + ' [mcp-live-test]').slice(0, 100));
    check('edit_profile kept name and address', saved.user?.username === before.username && saved.user?.permalink === before.permalink);
  } finally {
    const back = await call('edit_profile', { caption });
    restored = back.user?.caption === caption;
  }
  check('caption restored', restored);
  const invalid = await client.callTool({ name: 'edit_profile', arguments: { genres: ['no-such-genre-mcp'] } });
  check('edit_profile refuses an unknown genre', invalid.isError === true, (invalid.content?.[0]?.text ?? '').slice(0, 60));
}

// 7. edit_set: the description of the private own set changed and restored
{
  const sets = await call('list_my_sets', { count: 50 });
  const set = (Array.isArray(sets) ? sets : []).find((entry) => String(entry.privat) === '1' && String(entry.user_id) === String(me.id));
  if (!set) {
    check('private own set found', false);
  } else {
    const original = String(set.description ?? '');
    const marker = (original + ' [mcp-live-test]').trim();
    const find = async () => ((await call('list_my_sets', { count: 50 })) ?? []).find((entry) => String(entry.id) === String(set.id));
    try {
      await call('edit_set', { set_id: Number(set.id), description: marker });
      const changed = await find();
      check('edit_set changed the description', String(changed?.description ?? '') === marker);
      check('edit_set left the set private', String(changed?.privat) === '1');
    } finally {
      await call('edit_set', { set_id: Number(set.id), description: original });
    }
    check('set description restored', String((await find())?.description ?? '') === original);
  }
}

// 8. Refusals that never reach the API
for (const [name, args] of [
  ['get_user', { author: 'login' }],
  ['set_track_cover', { track_id: Number(own.id), image_path: '/etc/passwd' }],
  ['upload_track', { file_path: '/etc/hosts' }],
]) {
  const result = await client.callTool({ name, arguments: args });
  check(`${name} refused locally`, result.isError === true, (result.content?.[0]?.text ?? '').slice(0, 60));
}

await client.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
