# Third-party code and attribution

The root project is distributed under [MIT](LICENSE). The bundled updater was
imported from `cmux-companion-updater`; its separate [MIT notice](updater/LICENSE)
and [source provenance](updater/PROVENANCE.md) are retained. Do not replace that
notice with the root project's copyright attribution.

Dependencies are installed from the root npm lockfile, not vendored into this
source repository. Their licenses remain their own; the root MIT license does
not relicense them. `package.json` stays `private: true` to prevent accidental
npm publication; this does not prevent publishing the source repository.

## Runtime dependencies

| Package | Declared license |
| --- | --- |
| `@fastify/http-proxy`, `@fastify/websocket`, `fastify` | MIT |
| `jsonc-parser` | MIT |
| `playwright-core` | Apache-2.0; includes a NOTICE |
| `react`, `react-dom`, `react-markdown` | MIT |
| `rehype-highlight`, `remark-gfm` | MIT |
| `web-push` | MPL-2.0 |

Build/test dependencies also include MIT, Apache-2.0, BSD, ISC and other licenses.
In particular, the Cloudflare image tooling includes LGPL-3.0-or-later libvips
packages, and `caniuse-lite` declares CC-BY-4.0. The lockfile records licenses for
all resolved packages as of the [readiness audit](docs/open-source-readiness.md).

Publishing this source with its lockfile differs from distributing `node_modules`,
compiled applications, containers or native binaries. Before distributing those
artifacts, include the applicable dependency licenses/NOTICE files and satisfy
source/attribution obligations for the actual bundled components, including
MPL/LGPL components. This inventory does not replace their full license texts.

cmux, Tailscale, Git, GitHub CLI, CCS, provider CLIs and the user's browser are
external integrations installed separately; this repository does not distribute
them or grant rights to their trademarks.
