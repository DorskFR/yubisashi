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
   If the pane says "Hot reload lost", the page stopped receiving updates: ask the user to
   press its "Reload page" button, or run `yubi go reload` yourself.
3. Answer in your normal reply, referring to the comment number. When the reply is about a
   particular element, point at it with `yubi show` (see Point) and refer to its number.

Comments without a target are general remarks about the app.

## Look for yourself: `yubi look`

While `yubi dev` runs and the user has the yubisashi pane open, you can read what their browser
shows right now. Run these from the directory where `yubi dev` was started (it leaves
`.yubisashi/dev.json` there):

```sh
npx -y @dorsk/yubisashi look page                      # route, title, viewport, scroll, focus
npx -y @dorsk/yubisashi look dom '.card'               # live DOM under a selector (default body)
npx -y @dorsk/yubisashi look styles '.card > h2'       # computed style, box, visibility, source
npx -y @dorsk/yubisashi look shot                      # PNG of the viewport, path printed
npx -y @dorsk/yubisashi look shot '.card' --scale 2    # PNG of one element
```

`--json` prints raw JSON. `look dom` takes `--depth N` and `--max-bytes N`; `look styles` takes
`--props color,display`, `--all` and `--pseudo ::before`; `look shot` takes `--out FILE` and
`--scale N`.

When to use it:

- After an edit and the hot reload, check the result yourself with `look styles` or `look shot`
  before telling the user it is fixed.
- When a comment's HTML is not enough to explain a layout, overflow or z-index problem, ask
  `look styles` for the element rather than guessing. It reports what differs from a bare
  element, the box model, whether the element is visible (and what covers it), the resolved
  CSS variables, the source `file:line` and the component chain.
- Prefer `page`, `dom` and `styles` (cheap text) over `shot` (image tokens). Use `shot` only for
  visual questions: alignment, colours, what the user actually sees.
- `look dom` annotates Svelte elements with `data-yubi-src="file:line"`; that is where to edit.

Every request shows up in the pane as "Agent looked: …", and the user can switch looking off.

Errors and what to do:

- "no `yubi dev` running here": start it (see Start), from the app's directory.
- "no browser has the app open": ask the user to open the yubisashi pane; a plain tab on the
  preview URL does not serve looks.
- "the user has turned looking off": do not retry. Ask the user what they would like you to
  see, or ask them to switch "Let the agent look" back on.
- "the browser did not answer": the tab may be in the background or busy; try once more, then
  ask.
- "the tab answering this request went away": the page reloaded or the user closed the pane
  mid-request; run the command again once.
- "the shot did not finish within …s (time budget)" or "the shot is … over the … budget": the
  page is too heavy to rasterize whole; shoot one element with a selector, or pass
  `--scale 0.5`.
- A `shot` always prints a warning line about what the DOM raster cannot render (cross-origin
  images, `<video>`, some filters, tainted canvases). Do not take blank areas there as a bug.

## Navigate: `yubi go`

Instead of asking the user to open a page, move their tab there yourself, from the same
directory as `yubi look`:

```sh
npx -y @dorsk/yubisashi go /settings/interface?x=1     # a path of the same app
npx -y @dorsk/yubisashi go /sessions --scroll '.row:nth-of-type(20)'
npx -y @dorsk/yubisashi go back                        # also: forward, reload
```

It goes through the app's own client router when there is one (SvelteKit and other
link-intercepting routers keep their state), waits for the page to settle and prints the same
summary as `look page`. Only paths of the framed app's origin are accepted; other URLs are
refused. Each navigation shows in the pane as "Agent navigated: /from → /to".

- Navigate only when it helps: to check an edit on the page it affects, or to look at something
  the user mentioned. Do not wander around the app.
- "user is busy: typing in …": the user has unsaved text in a field. Do not retry in a loop; ask
  them, or wait for their next message.
- "Let the agent look" off also refuses `go` (and `show`): do not retry; ask the user.
- `yubi go reload` reloads the page where it is (useful after "Hot reload lost").

## Point: `yubi show`

When you talk about an element in a reply ("this badge", "the second row"), use `show` to point
at it in the user's tab instead of describing where it is:

```sh
npx -y @dorsk/yubisashi show '.badge' --label 'too dark'     # first match, numbered 1
npx -y @dorsk/yubisashi show '.row' --all --ttl 30            # every match, kept 30 s
npx -y @dorsk/yubisashi show --clear                          # remove all highlights
```

Each highlight is an outline with a numbered tag; calls stack (1, 2, 3, …) so you can write
"see 2 and 3" in the reply. It scrolls the element into view, follows it on scroll, and goes
away after `--ttl` seconds (default 10, `0` keeps it), on `--clear`, or when the user clicks it.
The command prints each number with its selector and source `file:line`, and errors on 0
matches like `look`. The pane lists each as "Agent showed: <label>" and scrolls back to it on
click. Highlights never block clicks in the app.

## Stop

When the user says they are done, stop the background command. That shuts the proxy down
(and the cctui preview) and kills the dev server it started.
