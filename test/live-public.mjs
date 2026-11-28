// Live test of the public MCP endpoint of hearthis.at (https://api-v2.hearthis.at/mcp/) with the SDK's own client over
// HTTP - in each way a client can open the connection: the initialize handshake, the 2026-07-28 revision pinned, and the
// automatic choice. Read-only, no account, no credentials.
// node test/live-public.mjs [url]
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const URL_ = process.argv[2] ?? 'https://api-v2.hearthis.at/mcp/';
let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(ok ? 'ok  ' : 'FAIL', label, detail);
  failed += ok ? 0 : 1;
};
const text = (result) => result.content?.[0]?.text ?? '';

for (const [label, options] of [
  ['handshake', {}],
  ['2026-07-28 pinned', { versionNegotiation: { mode: { pin: '2026-07-28' } } }],
  ['automatic', { versionNegotiation: { mode: 'auto' } }],
]) {
  // the endpoint serves 10 requests in ten seconds from one address: each round begins in a slot of its own
  await new Promise((resolve) => setTimeout(resolve, 11_000));
  const client = new Client({ name: 'live-public', version: '0' }, options);
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(URL_)));
    check(true, `${label}: connected`, `as ${JSON.stringify(client.getServerVersion?.() ?? {})} ${client.getNegotiatedProtocolVersion?.() ?? ''}`);
    check(/never signs in/.test(client.getInstructions?.() ?? ''), `${label}: instructions say it never signs in`);
    const { tools } = await client.listTools();
    check(tools.length === 14 && tools.every((tool) => tool.annotations?.readOnlyHint === true), `${label}: 14 read-only tools`, tools.map((tool) => tool.name).join(','));
    const genres = await client.callTool({ name: 'list_genres', arguments: {} });
    check(!genres.isError && JSON.parse(text(genres)).length > 30, `${label}: list_genres answers`);
    const feed = await client.callTool({ name: 'get_feed', arguments: { type: 'popular', count: 2 } });
    const tracks = feed.isError ? [] : JSON.parse(text(feed));
    check(tracks.length > 0 && !('waveform_data' in tracks[0]), `${label}: get_feed answers a cut list`, tracks[0]?.title ?? text(feed).slice(0, 80));
    if (tracks[0]) {
      const track = await client.callTool({ name: 'get_track', arguments: { author: tracks[0].user.permalink, track: tracks[0].permalink } });
      check(!track.isError && typeof JSON.parse(text(track)).stream_url === 'string', `${label}: get_track answers the whole sound`);
    }
    const faq = await client.callTool({ name: 'get_faq', arguments: { query: 'upload limit', count: 2 } });
    check(!faq.isError && text(faq).includes('"hits"'), `${label}: get_faq searches`);
    const setup = await client.callTool({ name: 'connect_account', arguments: {} });
    check(!setup.isError && text(setup).includes('npx hearthis-mcp login'), `${label}: connect_account answers the setup`);
    const wrong = await client.callTool({ name: 'search', arguments: { type: 'tracks' } }).then((result) => (result.isError ? text(result) : 'answered'), (error) => 'threw: ' + error.message);
    check(/Give query/.test(wrong), `${label}: a missing argument is said by the tool`, wrong.slice(0, 60));
    const account = await client.callTool({ name: 'send_message', arguments: { text: 'x' } }).then((result) => 'answered: ' + text(result), (error) => error.message);
    check(/npx hearthis-mcp login/.test(account), `${label}: a tool of the installable server points to it`, account.slice(0, 70));
  } catch (error) {
    check(false, `${label}: ${error.message}`);
  } finally {
    await client.close().catch(() => {});
  }
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
