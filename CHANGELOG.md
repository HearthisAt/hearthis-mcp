# Changelog

## Unreleased

- README: the public endpoint of hearthis.at (`https://api-v2.hearthis.at/mcp/`) for reading without an account.
- `test/live-public.mjs` connects to that endpoint with the SDK client over HTTP, in each way of version negotiation.

## 0.7.0

- Link page (https://hearthis.at/@yourname/): `get_link_page` reads it - its links in order, hidden ones too, the picked
  sounds and sets and how a sound opens -, `edit_link_page` sets the order, hides a link of the profile, adds or removes
  links only this page has, picks sounds and sets and switches between playing on the page and opening on hearthis.at.
  `get_link_page_stats` has its opens, clicks, plays, shares, clicked links, sources and countries over 7, 30 or 90 days.
- With an API key: reading the link page and its statistics needs *Read*, changing it *Upload and edit*.

## 0.6.0

- Sign in with a personal API key: `HEARTHIS_API_KEY=htp_…` instead of the key pair, and `npx hearthis-mcp login` takes a
  key at its prompt. No password involved - for accounts that sign in with Google, Facebook or a passkey too. Create the
  key at https://studio.hearthis.at/channel/#account with the rights the assistant should have: *Read*, *Likes, follows
  and comments*, *Upload and edit*, *Messages*.
- With a key the server offers every tool but `delete_conversation`. A tool the key lacks the right for says which right
  it needs, before any request.
- The key pair (`HEARTHIS_KEY`, `HEARTHIS_SECRET`) works as before, with every tool.
- Statistics: `get_account_stats` (the account over 7, 28, 90 or 365 days) and `get_track_stats` (one own track).
- `get_faq`: the FAQ of hearthis.at - search it, read one answer or list all questions, in ten languages. The assistant
  looks there before answering a question about hearthis.at itself.
- `edit_profile` and `badge_settings` use the documented paths `/my/profile/` and `/my/badges/`.

## 0.5.0

- MCP 2026-07-28: the server answers `server/discover` and requests that carry their protocol version in `_meta`, without
  the `initialize` handshake. Clients of the earlier revisions (2025-11-25 and before) keep working unchanged - the
  connection's first message decides which revision it speaks.
- The tool list may be cached by the client for an hour (`ttlMs`); it only changes with a new version.
- Built on the v2 MCP SDK (`@modelcontextprotocol/server`). Same 69 tools, same answers; progress during long calls and
  cancelling a call work in both revisions.
- Tool input schemas now declare JSON Schema 2020-12 (was draft-07). A client that validates tool schemas with a
  draft-07-only validator needs 2020-12 support.

## 0.4.0

- Feed sync (https://hearthis.at/imports/): `list_feeds`, `add_feed`, `edit_feed`, `check_feed`, `remove_feed` - podcast and
  SoundCloud feeds whose new episodes come in as sounds every hour; changed titles and descriptions follow the feed unless
  the user changed them on hearthis.at. Premium, up to 3 feeds per profile.

## 0.3.0

- Workflows (https://hearthis.at/workflows/): `list_workflows`, `create_workflow`, `edit_workflow`, `delete_workflow`,
  `order_workflows`, `test_workflow` (writes nothing - a saved workflow or a draft, also on one sound), `apply_workflow`
  with `get_workflow_run` and `cancel_workflow_run`, `workflow_history` and `undo_workflow` (one entry or a whole run).
- Webhook as a workflow action and `workflow_webhook` (how calls are signed, a new secret, a test call - the secret itself stays on the site).
- `list_control_tags` and `control_tags` on `edit_track`: tags like `+radio` that only the owner sees and that
  steer workflows.

## 0.2.0

- `get_group` and `join_group` take `invite`: the share link of a private group (or just its secret). hearthis.at now
  answers a private group only to its owner, its members and holders of that link, and lets nobody else join.
- `edit_group` takes `allowed_genres`: the genres members may add to the group (an empty list accepts every genre
  again). `get_group` names them in `info`, and `group_track` says why a sound of another genre is refused.

## 0.1.0

First release.

- 51 tools for hearthis.at over its public API: feed, genres, search, events, tracks, comments and reactions, uploads
  and the full track edit, profile, sets, groups (with approval, blocks and roles) and direct messages.
- Premium members only - checked by the API and at every start.
- `npx hearthis-mcp login` prints the key pair and the client configuration; the password is not stored.
- Key pair never in any answer; uploads private by default, local files limited to audio and JPG/PNG covers
  (optionally to `HEARTHIS_UPLOAD_DIR`).
- Tools that delete, overwrite, undo or publish carry `destructiveHint`; long calls send progress and can be cancelled.
