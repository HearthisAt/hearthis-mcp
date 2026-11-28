# hearthis-mcp

MCP server for [hearthis.at](https://hearthis.at) - lets an AI assistant (Claude, or any MCP client) browse,
search, upload, edit and message on hearthis.at as your account.

**Available for hearthis.at Premium members only.** The API refuses requests of this server from accounts
without Premium (`403 premium_required`).

## Setup

Needs Node.js 20 or newer. Speaks MCP 2026-07-28 and still serves clients of the earlier revisions (2025-11-25 and
before), over stdio.

```sh
npx hearthis-mcp login
```

Asks for your hearthis.at e-mail and password - or a personal API key - once and prints the line to add the server to
your MCP client. There are two ways to sign in:

**A personal API key** (no password involved). Create one in your hearthis.at settings under
[Account & connections → API keys](https://studio.hearthis.at/channel/#account), choose what it may do, and paste it at the prompt of
`login` - or put it straight into the configuration as `HEARTHIS_API_KEY`:

```sh
claude mcp add hearthis -e HEARTHIS_API_KEY=htp_… -- npx -y hearthis-mcp
```

```json
{ "hearthis": { "command": "npx", "args": ["-y", "hearthis-mcp"], "env": { "HEARTHIS_API_KEY": "htp_…", "HEARTHIS_UPLOAD_DIR": "/Users/me/Music/Uploads" } } }
```

The key decides what the assistant can do:

| Right of the key | Tools |
|---|---|
| *Read* | browsing, searching, your feed, sets, private sounds, statistics and your link page |
| *Likes, follows and comments* | likes, reposts, listen later, comments, reactions, follows, joining a group |
| *Upload and edit* | uploads, editing and deleting sounds, sets and groups, your profile, badges and link page, workflows and feed sync |
| *Messages* | reading and answering your direct messages |

A tool the key has no right for says which right it needs. A key works for accounts without a password (Google,
Facebook or passkey sign-in), shows up in your settings with its last use and is revoked there with one click. The only
tool no key reaches is `delete_conversation` (it deletes the conversation for both sides) - it is not offered with a key.

**E-mail and password** - every tool. `login` prints your key pair; the password is not stored. The pair acts as your
whole account - keep it secret.

```sh
claude mcp add hearthis -e HEARTHIS_KEY=… -e HEARTHIS_SECRET=… -- npx -y hearthis-mcp
```

```json
{ "hearthis": { "command": "npx", "args": ["-y", "hearthis-mcp"], "env": { "HEARTHIS_KEY": "…", "HEARTHIS_SECRET": "…", "HEARTHIS_UPLOAD_DIR": "/Users/me/Music/Uploads" } } }
```

`HEARTHIS_UPLOAD_DIR` is optional (see below). A command line with a key stays in your shell history - the config
file keeps it out. With both set, `HEARTHIS_API_KEY` wins.

**Lost or leaked?** An API key: revoke it in your settings and create a new one. The key pair: in your profile
settings, under *Combine your accounts*, switch on *Renew the key on save* and save. Every client with the old pair
loses access; run `npx hearthis-mcp login` again.

## Tools

| Area | Tools |
|---|---|
| Account & discovery | `whoami`, `get_account_stats`, `get_faq`, `get_feed`, `list_genres`, `get_genre_tracks`, `get_home_section`, `search`, `get_events`, `get_listen_history`, `get_listen_later` |
| Tracks | `get_track`, `get_track_stats`, `get_track_part`, `toggle_like`, `toggle_repost`, `set_listen_later`, `get_cast_url`, `post_comment`, `delete_comment`, `post_reaction`, `streaming_quality`, `copy_track_image` |
| Own tracks | `upload_track`, `edit_track`, `delete_track`, `set_track_cover`, `remove_track_cover` |
| Users | `get_user`, `edit_profile`, `toggle_follow`, `badge_settings`, `get_fan_subscriptions` |
| Link page | `get_link_page`, `edit_link_page`, `get_link_page_stats` |
| Sets | `list_my_sets`, `get_set`, `add_to_set`, `edit_set`, `remove_from_set`, `delete_set` |
| Groups | `list_groups`, `get_group`, `create_group`, `join_group`, `edit_group`, `group_track`, `group_approve`, `group_block`, `group_member_role`, `delete_group` |
| Messages | `list_conversations`, `read_conversation`, `poll_messages`, `send_message`, `delete_conversation` |
| Feeds | `list_feeds`, `add_feed`, `edit_feed`, `check_feed`, `remove_feed` |
| Workflows | `list_workflows`, `create_workflow`, `edit_workflow`, `delete_workflow`, `order_workflows`, `test_workflow`, `apply_workflow`, `get_workflow_run`, `cancel_workflow_run`, `workflow_history`, `undo_workflow`, `list_control_tags`, `workflow_webhook` |

Tools that delete, overwrite, undo or publish carry the MCP `destructiveHint`, so clients ask before running them;
only purely additive ones (comments, reactions, messages, adding to a set, creating a group) do not. Not included on purpose:
registration, password reset, account deletion, payments, billing address and subscription changes - do
those on the website.

Track lists come back with the essential fields of each track; `get_track` returns the full object. No answer
ever contains your key pair or your API key.

Workflows do the routine work on your uploads by rule (When - If - Then): into sets and groups, downloads, podcast,
tags, control tags like `+radio` that only you see, an email to you, or a signed webhook call to your own address. Let the assistant test a workflow first
(`test_workflow` writes nothing) and start a new one as a test run (`state: "log"`); `apply_workflow` runs it over the
sounds you have, and every change can be undone (`undo_workflow`). `edit_track` sets control tags with `control_tags`.

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
npm run test:protocol                       # offline: progress and cancel in both protocol eras (about 40 s)
node test/live-smoke.mjs path/to/env-file   # read-only calls against the live API, once per protocol era
node test/live-write.mjs path/to/env-file   # reversible writes on the test account, each turned back
npm run test:key                            # offline: sign-in with a personal API key (no network)
node test/live-key.mjs path/to/env-file     # the same against the live API: two keys made, used and revoked
```

The env file needs `HEARTHIS_TEST_EMAIL` and `HEARTHIS_TEST_PASSWORD` of a Premium account.
