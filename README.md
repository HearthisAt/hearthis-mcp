# hearthis-mcp

MCP server for [hearthis.at](https://hearthis.at) - lets an AI assistant (Claude, or any MCP client) browse,
search, upload, edit and message on hearthis.at as your account.

**Available for hearthis.at Premium members only.** The API refuses requests of this server from accounts
without Premium (`403 premium_required`).

## Setup

Needs Node.js 20 or newer.

```sh
npx hearthis-mcp login
```

Asks for your hearthis.at e-mail and password once and prints your API key pair plus the line to add the
server to your MCP client. The password is not stored; the key pair acts as your account - keep it secret.

Claude Code:

```sh
claude mcp add hearthis -e HEARTHIS_KEY=… -e HEARTHIS_SECRET=… -- npx -y hearthis-mcp
```

Other clients (`mcpServers` entry):

```json
{ "hearthis": { "command": "npx", "args": ["-y", "hearthis-mcp"], "env": { "HEARTHIS_KEY": "…", "HEARTHIS_SECRET": "…", "HEARTHIS_UPLOAD_DIR": "/Users/me/Music/Uploads" } } }
```

`HEARTHIS_UPLOAD_DIR` is optional (see below). A command line with the pair stays in your shell history - the config
file keeps it out.

**Lost or leaked key pair?** In your hearthis.at profile settings, under *Combine your accounts*, switch on *Renew the
key on save* and save. Every client with the old pair loses access; run `npx hearthis-mcp login` again.

## Tools

| Area | Tools |
|---|---|
| Account & discovery | `whoami`, `get_feed`, `list_genres`, `get_genre_tracks`, `get_home_section`, `search`, `get_events`, `get_listen_history`, `get_listen_later` |
| Tracks | `get_track`, `get_track_part`, `toggle_like`, `toggle_repost`, `set_listen_later`, `get_cast_url`, `post_comment`, `delete_comment`, `post_reaction`, `streaming_quality`, `copy_track_image` |
| Own tracks | `upload_track`, `edit_track`, `delete_track`, `set_track_cover`, `remove_track_cover` |
| Users | `get_user`, `edit_profile`, `toggle_follow`, `badge_settings`, `get_fan_subscriptions` |
| Sets | `list_my_sets`, `get_set`, `add_to_set`, `edit_set`, `remove_from_set`, `delete_set` |
| Groups | `list_groups`, `get_group`, `create_group`, `join_group`, `edit_group`, `group_track`, `group_approve`, `group_block`, `group_member_role`, `delete_group` |
| Messages | `list_conversations`, `read_conversation`, `poll_messages`, `send_message`, `delete_conversation` |

Tools that delete, overwrite, undo or publish carry the MCP `destructiveHint`, so clients ask before running them;
only purely additive ones (comments, reactions, messages, adding to a set, creating a group) do not. Not included on purpose:
registration, password reset, account deletion, payments, billing address and subscription changes - do
those on the website.

Track lists come back with the essential fields of each track; `get_track` returns the full object. No answer
ever contains your key pair.

Uploads stay private unless the assistant sets `private=false`. Only audio files (and JPG/PNG covers) can be
sent; set `HEARTHIS_UPLOAD_DIR` to allow files from that folder only.

## Limits

The hearthis.at API limits the requests of this server per account and per action (messages, comments, uploads, …)
and answers `429` above them. The server waits on its own for short `Retry-After` pauses (up to 20 s) and reports
longer ones. Long calls (uploads) send progress notifications, and a cancelled call aborts its request.

## Feedback

Issues and pull requests: https://github.com/HearthisAt/hearthis-mcp. API documentation: https://hearthis.at/api/
(for Premium members).

## Development

```sh
npm install
npm run build
node test/live-smoke.mjs path/to/env-file   # read-only calls against the live API
node test/live-write.mjs path/to/env-file   # reversible writes on the test account, each turned back
```

The env file needs `HEARTHIS_TEST_EMAIL` and `HEARTHIS_TEST_PASSWORD` of a Premium account.
