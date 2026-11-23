# Changelog

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
