# Architecture

Two halves, joined by `postMessage`:

- **Review panel**: the `yubisashi` plugin in cctui. Frames the app, drives picking, holds the
  comment threads and talks to the agent's session. Not in this repo.
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

Injection goes through the response rather than `transformIndexHtml` because SvelteKit renders
`app.html` itself and never calls that hook in dev. Rewriting the response covers plain Vite,
SvelteKit and anything else that serves HTML through the dev server.

Security model: the picker only accepts messages from `window.parent` at an allowed origin and
only posts to allowed origins; every message carries `yubi: 1`. The plugin never runs in
`vite build`, so nothing of this reaches production.
