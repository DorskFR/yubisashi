# yubisashi 指差し

Point at elements of your running app from a review panel and hand the coding agent the exact
source `file:line`, the component chain, the selector and your comment.

The review panel lives in [cctui](https://github.com/DorskFR/cctui) as the opt-in **yubisashi**
plugin. This package is the app side: a framework-free picker that runs inside the framed app,
and a Vite plugin that injects it in dev.

## Use

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

Then in cctui: **Settings → Plugins → yubisashi**, open the **Review** pane and point it at the
dev server. Press `C` or the ⌖ button, click an element (shift-click adds more, `Esc` backs
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

App → parent:

| type            | fields                                          |
| --------------- | ----------------------------------------------- |
| `route`         | `route: string`                                 |
| `pick:state`    | `picking: boolean`                              |
| `pick:hover`    | `target: Target \| null`                        |
| `pick:selected` | `targets: Target[]`, `route`, `viewport`        |
| `pick:cancel`   |                                                 |
| `pin:open`      | `id: number`                                    |

`Target`: `tag`, `selector`, `text`, `html`, `attrs`, `rect`, `source?: { file, line, column }`,
`stack: Frame[]` (the components that rendered it). Types and the `isParentMessage` /
`isChildMessage` guards are exported from `@dorsk/yubisashi/picker`.

## Develop

```sh
npm install
npx playwright install chromium
npm run lint    # biome
npm run check   # tsc
npm test        # builds dist, then Playwright tests for the picker and the Vite plugin (plain Vite + SvelteKit)
```
