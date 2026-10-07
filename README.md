# yubisashi 指差し

Point at elements of your running app from a review panel and hand the coding agent the exact
source `file:line`, the component chain, the selector and your comment.

The review panel lives in [cctui](https://github.com/DorskFR/cctui) as the opt-in **yubisashi**
plugin. This package is the app side: a framework-free picker that runs inside the framed app,
a `yubi dev` proxy that injects it without touching the app's config, and a Vite plugin as the
in-config alternative.

## Use without changing the app: `yubi dev`

```sh
npx -y @dorsk/yubisashi dev -- npm run dev
```

Under cctui (`cctui-daemon` on `PATH` and `CCTUI_SESSION_ID` set, as in every agent session)
that is all: the proxy listens on loopback over plain HTTP, registers itself with
`cctui-daemon preview open --port <port>` and prints the cctui preview URL, `yubisashi:
https://cctui-pv-<id>.example.com/`, which the yubisashi pane frames through cctui's tunnel
(cctui terminates TLS and authenticates the owner). The parent origin defaults to
`CCTUI_WEB_ORIGIN`; `--no-cctui` opts out. On exit it runs `preview close`.

Sessions whose adapter does not export `CCTUI_SESSION_ID` can name the session instead:
`yubi dev --session <id> -- npm run dev`. The flag wins over the environment variable.

Outside cctui, pass `--parent-origin https://cctui.example.com`. It then serves the app on
`https://127.0.0.1:4780` for the pane to frame. In both modes it:

- finds the dev server from the first `http://localhost:PORT` the command prints (Vite's
  `Local:` line), or takes `--target URL` (default `http://localhost:5173`); leave out
  `-- <command>` when the server is already running;
- proxies HTTP and WebSocket upgrades (HMR keeps working), rewriting `Host`/`Origin`/`Referer`
  toward the dev server and `Location` redirects to the app origin into relative ones;
- injects `<script type="module" src="/__yubi/picker.js">` into every HTML response (asking the
  dev server for identity encoding, decompressing when it insists), drops `X-Frame-Options` and
  rewrites CSP `frame-ancestors` to the `--parent-origin` list (repeatable, or
  `YUBI_PARENT_ORIGIN` comma-separated);
- over HTTPS, rewrites the app's cookies to `SameSite=None; Secure; Partitioned`: the review
  panel is another site, and browsers drop `Lax`/`Strict` and unpartitioned cookies in a
  cross-site frame, which would log the app out inside the pane;
- listens on `127.0.0.1` only unless told otherwise. To reach it from another device, bind the
  interface you choose with `--host ADDRESS` (or `YUBI_HOST`); nothing scans the machine's
  interfaces, and only the address you configure is printed or put in a certificate;
- serves HTTPS with your certificate when given `--cert FILE --key FILE` (or `YUBI_TLS_CERT` /
  `YUBI_TLS_KEY`), e.g. one from your own CA for a DNS name, printed with `--advertise NAME`
  (or `YUBI_ADVERTISE`). Otherwise it generates one per local address, naming only the address
  the browser connected to, with `mkcert` when it is on `PATH` (trusted by browsers that trust
  its CA) or a self-signed one from `openssl`, cached in `${XDG_CACHE_HOME:-~/.cache}/yubisashi/`.
  A self-signed certificate must be accepted once by opening the URL in a tab. `--http`
  disables TLS (with a warning when not on loopback).

Keep machine-specific settings (`YUBI_HOST`, `YUBI_ADVERTISE`, `YUBI_TLS_*`, `YUBI_PARENT_ORIGIN`)
in your own environment, not in the project.

When ready it prints the URL, `yubisashi: https://<host>:4780/`, which cctui
picks up to open the yubisashi pane. The proxy serves only the app and the picker; there is no API
and no token. `Ctrl-C` (or stopping the background task) kills the dev command with it.

The package also ships `skill/SKILL.md`, a Claude Code skill describing the review loop for an
agent.

## Looking: `yubi look`

The agent can read what the user's browser shows, through the same pane. `yubi dev` opens a
request channel between the CLI and the framed picker; `yubi look` uses it from the directory
where `yubi dev` was started.

```sh
yubi look page                        # route, title, viewport, scroll, device pixel ratio, focus
yubi look dom [selector]              # the live DOM, compact; default root is body
yubi look styles <selector>           # computed style, box model, rect, visibility, source
yubi look shot [selector]             # PNG rendered from the DOM in the user's tab
```

Every command takes `--json` (raw JSON) and `--timeout S` (default 15 s, 60 s for `shot`).

- `look dom` serializes the DOM as the user has it: current form values (`:value="…"`,
  `:checked`), runtime classes, open/closed state. `<script>`/`<style>` bodies are dropped, SVG
  path data collapsed, long text and attributes cut, subtrees past `--depth N` (default 12)
  replaced by `<!-- N children -->`, and the whole thing capped at `--max-bytes N` (default
  40960) with a `<!-- truncated -->` marker. Elements rendered by Svelte in dev carry
  `data-yubi-src="file:line"`. A selector matching nothing or several elements is an error that
  lists the count and the first matches.
- `look styles` prints what differs from a bare element of the same tag (a probe appended to
  `body` and removed at once), or `--props a,b` / `--all`; `--pseudo ::before` targets a
  pseudo-element. It adds the content/padding/border/margin boxes, `getBoundingClientRect`, a
  visibility verdict (display, visibility, opacity, zero size, off-screen, covered by which
  element), the `var(--x)` values the element uses, the source `file:line` and the component
  chain. With several matches it takes the first.
- `look shot` rasterizes the viewport or one element with a DOM-to-canvas renderer
  ([modern-screenshot](https://github.com/qq15725/modern-screenshot)) inside the user's tab, no
  permission prompt. The renderer is a separate chunk, `/__yubi/raster.js`, fetched on the first
  shot; the picker itself stays dependency-free. The PNG lands in `.yubisashi/shots/<timestamp>.png`
  (or `--out FILE`), `--scale N` sets the pixel ratio, and a warning line lists what a raster
  cannot show: cross-origin images without CORS, `<video>`, some filters and
  `backdrop-filter`, canvases tainted by cross-origin content. `--raster` is accepted; the DOM
  raster is the only capture path.

Errors are explicit: "no `yubi dev` running here", "no browser has the app open" (nothing is
subscribed: a plain tab on the preview URL never serves looks), "the user has turned looking
off", "the browser did not answer". Each exits non-zero with its own code.

### Security model

- `yubi dev` generates a random token per run and writes `{ scheme, host, port, token, pid }` to
  `.yubisashi/dev.json` in its working directory (mode 0600, `.yubisashi/` added to
  `.git/info/exclude`), removed on exit. `POST /__yubi/look` requires
  `Authorization: Bearer <token>`: the cctui tunnel also arrives on loopback, so loopback alone
  is not proof of who is asking.
- The picker side (`GET /__yubi/look/events`, `POST /__yubi/look/result/:id`,
  `POST /__yubi/look/state/:sub`) is reached through the pane's frame, so it is protected by the
  tunnel's owner authentication, like the app itself. Request ids are unguessable nonces, a
  result is accepted once per id and only while that request is pending, and results are capped
  at 10 MB. With several framed tabs, a request goes to the most recently active one only.
- Consent: the pane has a "Let the agent look" switch, on by default and remembered per user
  (browser storage). While it is off the proxy answers 403 and the CLI says so. Every served
  request is announced to the pane as `look:served` and shown as "Agent looked: styles
  `.card > h2`", with a counter in the status bar.
- The picker subscribes only when it is framed by an allowed origin and was injected by
  `yubi dev` (the Vite plugin has no look channel). `yubi dev --no-look` turns the channel off
  altogether; `--look-timeout S` changes the default wait.

Live tab capture (sharing the tab itself) is not part of this release; `shot` is always the DOM
raster.

## Use as a Vite plugin

```sh
npm install --save-dev @dorsk/yubisashi
```

```ts
// vite.config.ts
import { yubisashi } from '@dorsk/yubisashi/vite';

export default defineConfig({
	plugins: [sveltekit(), yubisashi()],
});
```

```sh
YUBI_PARENT_ORIGIN=https://cctui.example.com npm run dev
```

The yubisashi pane frames only cctui previews, so publish the dev server with
`cctui-daemon preview open --port <port>` (or use `yubi dev`, which does it for you). Press `C` or the ⌖ button, click an element (shift-click adds more, `Esc` backs
out) and write the comment.

The plugin only runs under `vite dev` (`apply: 'serve'`) and does nothing at all unless
`YUBI_PARENT_ORIGIN` (comma-separated origins) or the `parentOrigin` option is set. When active,
it:

- injects `<script type="module" src="/@id/__x00__virtual:yubisashi">` into every HTML
  response, which calls `createPicker({ parentOrigin })` only when the page is inside an iframe;
- drops `X-Frame-Options` and rewrites CSP `frame-ancestors` to the configured origins so the
  panel may frame the app.

An `https` parent cannot frame a plain `http` page unless it is on `localhost`, so run the dev
server over https (`server.https`) when it lives anywhere else.

Source locations come from Svelte 5's dev-mode `__svelte_meta`. Other frameworks still get
selector, text, attributes and HTML.

## Picker on its own

```ts
import { createPicker } from '@dorsk/yubisashi/picker';

if (window.parent !== window)
	createPicker({ parentOrigin: ['https://cctui.example.com', 'http://localhost:5555'] });
```

The picker talks to the parent window through `postMessage` only. It accepts messages solely
from `window.parent` at an allowed origin; with several origins it pins itself to the one that
frames the document (`ancestorOrigins` / `referrer`), otherwise to the first allowed origin
that sends a valid message.

## Protocol

Every message, both ways, carries `yubi: 1`; anything without it is ignored.

Parent → app:

| type         | fields                     |
| ------------ | -------------------------- |
| `pick:start` |                            |
| `pick:stop`  |                            |
| `pick:clear` | `id?: number` (pin the selection to comment #id) |
| `pins:set`   | `pins: { id, selector }[]` |
| `look:allow` | `allowed: boolean` (the consent switch) |

App → parent:

| type            | fields                                          |
| --------------- | ----------------------------------------------- |
| `route`         | `route: string`                                 |
| `pick:state`    | `picking: boolean`                              |
| `pick:hover`    | `target: Target \| null`                        |
| `pick:selected` | `targets: Target[]`, `route`, `viewport`        |
| `pick:cancel`   |                                                 |
| `pin:open`      | `id: number`                                    |
| `look:served`   | `kind: string`, `selector?: string`             |

`Target`: `tag`, `selector`, `text`, `html`, `attrs`, `rect`, `source?: { file, line, column }`,
`stack: Frame[]` (the components that rendered it). Types and the `isParentMessage` /
`isChildMessage` guards are exported from `@dorsk/yubisashi/picker`.

Proxy ⇄ picker (HTTP, only under `yubi dev`):

| endpoint                        | who    | what                                                                                             |
| ------------------------------- | ------ | ------------------------------------------------------------------------------------------------ |
| `POST /__yubi/look`             | CLI    | `{ kind, args, timeout? }` with the bearer token; held until a result; 503 no browser, 504 timeout, 403 looking off |
| `GET /__yubi/look/events?sub=…` | picker | SSE stream of `{ id, kind, args }`                                                               |
| `POST /__yubi/look/result/:id`  | picker | `{ ok: true, data }` or `{ ok: false, error }`, accepted once                                    |
| `POST /__yubi/look/state/:sub`  | picker | `{ allowed }`; also marks that tab as the active one                                             |
| `GET /__yubi/raster.js`         | picker | the DOM-to-canvas renderer, fetched on the first `shot`                                          |

## cctui plugin

The same picker as a [cctui](https://github.com/DorskFR/cctui) runtime plugin: a **yubisashi**
pane next to the conversation that lists the session's cctui previews
(`GET /api/v1/sessions/{id}/previews`), frames the newest through a single-use ticket
(`/__cctui/auth?ticket=…`) and offers a selector when there are several, and an "Open in
yubisashi" action on every assistant line of the form `yubisashi: <url>` that selects the matching
preview. Picked elements land in the composer as `[yubisashi #N]` blocks. The plugin ships the
`yubisashi` skill so the agent knows how to start the proxy.

Install it on the cctui server:

1. Download `yubisashi-<version>.tgz` from the
   [release](https://github.com/DorskFR/yubisashi/releases) and extract it into the server's
   `CCTUI_PLUGINS_DIR`: `tar -xzf yubisashi-<version>.tgz -C "$CCTUI_PLUGINS_DIR"` (it creates
   `yubisashi/plugin.json`, `yubisashi/web/index.js` and `yubisashi/skills/yubisashi/SKILL.md`).
2. Rescan (`POST /api/v1/plugins/rescan` as an admin, or restart the server).
3. In cctui, open Settings → Plugins and enable **yubisashi**. Nothing else to configure:
   `yubi dev` finds `cctui-daemon` and the session on its own.

The plugin is built from `cctui-plugin/` with `npm run build:cctui` into `dist-cctui/` (the
folder plus the tarball). It imports Svelte and Tsumikit from the host's `/plugin-runtime/*`, so
it is compiled against the Svelte version the cctui webui ships.

## Develop

```sh
npm install
npx playwright install chromium
npm run lint    # biome
npm run check   # tsc
npm test        # builds dist, then Playwright tests for the picker and the Vite plugin (plain Vite + SvelteKit)
```
