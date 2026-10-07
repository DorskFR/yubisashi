# Architecture

Two halves, joined by `postMessage`, plus a third leg under `yubi dev`: a request stream from
the proxy to the picker, so the agent's `yubi look` can read the framed document.

- **yubisashi pane**: the `yubisashi` plugin in cctui (`cctui-plugin/`). Frames the app, drives picking, holds the
  pins and talks to the agent's session.
- **App side** (this package):
  - `src/picker/` — runs inside the framed app document. A fixed glass layer takes clicks while
    picking, draws hover/selection boxes and comment pins, reads Svelte's dev-mode
    `__svelte_meta` for `file:line` and the component chain, and speaks the protocol in
    `protocol.ts`. No framework, no dependencies.
  - `src/vite/` — dev-only Vite plugin. Inactive until a parent origin is configured. Then a
    `configureServer` middleware wraps every response: frame-blocking headers are relaxed to the
    allowed origins and HTML bodies get a module script pointing at the `virtual:yubisashi`
    module, which imports the picker from this package's `dist/` (added to `server.fs.allow`)
    and starts it only inside an iframe.

- **Look channel** (`src/look.ts`, `src/picker/look*.ts`, `src/look-cli.ts`): `yubi dev`
  mints a token, writes `.yubisashi/dev.json` and mounts `/__yubi/look*` on the proxy. The CLI
  posts `{ kind, args }` with the token; the proxy holds the request, sends it over SSE to the
  most recently active framed picker, and answers with whatever the picker posts back under the
  request's nonce (or 503/504/403). The picker dispatches on `kind`: `page`, `dom` (a compact
  live serialization with `data-yubi-src`), `styles` (computed diff against a bare probe, box,
  visibility, variables) and `shot` (DOM raster via `/__yubi/raster.js`, a lazy chunk of
  `modern-screenshot` served by the proxy). The pane's "Let the agent look" switch travels as
  `look:allow` to the picker, which tells the proxy; every answered request goes back to the
  pane as `look:served`.

```
yubi look ──token──▶ proxy ──SSE──▶ picker (framed) ──postMessage look:served──▶ pane
          ◀──JSON──        ◀─POST─          ◀──────────── look:allow ───────────
```

Injection goes through the response rather than `transformIndexHtml` because SvelteKit renders
`app.html` itself and never calls that hook in dev. Rewriting the response covers plain Vite,
SvelteKit and anything else that serves HTML through the dev server.

Security model: the picker only accepts messages from `window.parent` at an allowed origin and
only posts to allowed origins; every message carries `yubi: 1`. The plugin never runs in
`vite build`, so nothing of this reaches production. The look channel adds: a per-run bearer
token on the CLI endpoint (loopback is shared with the cctui tunnel), the tunnel's owner
authentication on the picker endpoints, unguessable request ids accepted once, a 10 MB result
cap, and the user's consent switch, which the proxy enforces with a 403.
