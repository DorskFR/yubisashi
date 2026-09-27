---
name: yubisashi
description: Use when the user wants to review a running web app visually and send you feedback by pointing at elements — "start a yubisashi server now" (sent by the cctui yubisashi pane when it opens with no preview), "start me a dev server with yubisashi", "let me comment on the UI", "I'll show you what I don't like". Starts the app's dev server behind the yubisashi proxy so the cctui yubisashi pane can frame it, and turns the user's element picks into normal messages in this session.
---

# yubisashi: UI review loop

The user opens the cctui **yubisashi** pane, points at elements of the running app and writes a
comment. Each comment reaches you as a normal user message carrying a `[yubisashi #N]` block
with the element's source `file:line`, the components that rendered it, a selector and an HTML
snippet.

## Start

On "start a yubisashi server now" (or any request to start a server with yubisashi), do this
immediately and without asking questions; the pane is polling for the preview. Run this as a
**background** command from the app's directory, replacing `npm run dev` with
the project's dev command:

```sh
npx -y @dorsk/yubisashi dev -- npm run dev
```

Under cctui there is nothing to configure: the proxy publishes itself as a preview of this
session and prints the URL the pane will frame:

```
yubisashi: https://cctui-pv-abc123.example.com/
```

Reply with that `yubisashi: <url>` line verbatim, on its own line, and tell the user to open the
yubisashi pane (cctui offers it on the message). Options: `--target URL` when the dev server's
URL is not printed on stdout (default `http://localhost:5173`).

Outside cctui, pass `--parent-origin <origin of the web UI framing the app>` (or set
`YUBI_PARENT_ORIGIN`); where it listens and which certificate it serves come from the user's
environment (`YUBI_HOST`, `YUBI_ADVERTISE`, `YUBI_TLS_CERT`, `YUBI_TLS_KEY`). Never pick an
address or network yourself; if the proxy logged that it generated a self-signed certificate,
tell the user to open the URL in a tab once and accept it.

## Each comment

1. Read the `[yubisashi #N]` block. `source:` is where the element is written; `rendered by:`
   lists the components that rendered it, innermost first. These are the files to edit.
2. Make the change. The dev server hot-reloads, so the user sees it in the pane immediately.
3. Answer in your normal reply, referring to the comment number.

Comments without a target are general remarks about the app.

## Stop

When the user says they are done, stop the background command. That shuts the proxy down
(and the cctui preview) and kills the dev server it started.
