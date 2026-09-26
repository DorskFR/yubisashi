---
name: yubisashi
description: Use when the user wants to review a running web app visually and send you feedback by pointing at elements — "let me comment on the UI", "start a review session", "I'll show you what I don't like". Starts the app's dev server behind the yubisashi proxy so the cctui Review pane can frame it, and turns the user's element picks into normal messages in this session.
---

# yubisashi: UI review loop

The user opens the cctui **Review** pane, points at elements of the running app and writes a
comment. Each comment reaches you as a normal user message carrying a `[yubisashi #N]` block
with the element's source `file:line`, the components that rendered it, a selector and an HTML
snippet.

## Start

Run this as a **background** command from the app's directory, replacing `npm run dev` with
the project's dev command. `--parent-origin` is the origin of the cctui web UI; use
`$CCTUI_WEB_ORIGIN` when that variable is set, otherwise ask the user for the URL they use to
open cctui.

```sh
npx -y @dorsk/yubisashi dev --parent-origin "$CCTUI_WEB_ORIGIN" -- npm run dev
```

Where it listens and which certificate it serves come from the user's environment
(`YUBI_HOST`, `YUBI_ADVERTISE`, `YUBI_TLS_CERT`, `YUBI_TLS_KEY`). Never pick an address or
network yourself: without `YUBI_HOST` it listens on this machine only; if the user's browser is
elsewhere, ask them which address to use.

Nothing in the app's config changes: the proxy injects the picker and relaxes frame headers
itself. Options: `--target URL` when the dev server's URL is not printed on stdout (default
`http://localhost:5173`), `--port N` (default 4780), `--http` to skip TLS (only works when
cctui itself is served over plain http).

When it is ready, it prints the URL:

```
yubisashi: https://review.example.test:4780/
```

Reply to the user with that `yubisashi: <url>` line verbatim, on its own line: cctui detects it
and opens the Review pane. If the proxy logged that it generated a self-signed certificate,
tell the user to open the URL in a tab once and accept it.

## Each comment

1. Read the `[yubisashi #N]` block. `source:` is where the element is written; `rendered by:`
   lists the components that rendered it, innermost first. These are the files to edit.
2. Make the change. The dev server hot-reloads, so the user sees it in the pane immediately.
3. Answer in your normal reply, referring to the comment number.

Comments without a target are general remarks about the app.

## Stop

When the user says they are done, stop the background command. That shuts the proxy down and
kills the dev server it started.
