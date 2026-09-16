# Third-party licensing and distribution

The Companion source is MIT-licensed under [LICENSE](../LICENSE). The imported
updater retains its separate [MIT copyright notice](../updater/LICENSE). Neither
notice relicenses third-party dependencies, artwork, fonts or external tools.

## Audit scope and result

The [2026-09-15 inventory](licenses/2026-09-15-dependencies.json) is bound to the
SHA-256 of `package-lock.json` at `ec816593`. It records all 976 locked package
entries, including development and optional dependencies, with versions,
registry integrity values and licensing metadata. All entries declare a license.
848 entries are installed on the audited macOS ARM64 machine and match the locked
versions; 128 absent optional/platform entries have metadata evidence only.

This inventory is not a complete third-party notice bundle or clearance to ship
prebuilt binaries. In particular, package license metadata does not enumerate
all libraries embedded in a native binary. 33 installed packages have no file
whose name identifies a license, notice or copyright statement; some describe
licenses in README files or inherit notices from their parent project. Retrieve
and preserve the exact upstream notices before including them in a distribution.
The inventory records which notice files actually exist, rather than inventing
copyright holders from SPDX identifiers.

The current installer/updater obtains source and runs `npm ci --include=dev`
and a local build (`updater/src/manifest.mjs`). It does not download a published
Companion binary. There were no GitHub releases or release assets at audit time.
A future archive containing `node_modules`, native libraries, fonts, Node or
browser runtimes has additional obligations. Do not treat `dev: true` as evidence
that a dependency is absent from an installed Companion release.

## Obligations by component

| Component in the locked graph | License evidence | Distribution requirement |
| --- | --- | --- |
| MIT, ISC, BSD, Blue Oak packages and the two Companion MIT notices | Package files and root/updater LICENSE | Preserve applicable copyright, license and disclaimer notices in copies or substantial portions. BSD includes its non-endorsement condition. |
| Apache-2.0 packages, including native workerd | Package metadata and available LICENSE/NOTICE files | Supply the license, preserve applicable attribution and NOTICE content, and identify modifications when distributing modified files. Audit embedded components separately. |
| `@img/sharp-libvips-*` 1.3.3; sharp WASM/Windows variants | LGPL-3.0-or-later, plus the native package's README and `versions.json` | Include applicable GPL/LGPL texts and notices, provide corresponding library source and build material through a compliant distribution method, and preserve the user's ability to modify/replace or relink the LGPL portions. Assess the actual dynamic/static/WASM linkage and any installation-information requirement. A package URL and MIT app license alone do not discharge this. |
| `lightningcss` 1.31.1 / 1.33.0 and native variants; `@resvg/resvg-wasm` 2.4.0; `@vercel/og` 0.8.6; `satori` 0.16.0; `axe-core` 4.11.4 | MPL-2.0 | Preserve notices and provide the covered source, including modifications to covered files, with a clear way for recipients of executable forms to obtain it. MPL does not automatically relicense unrelated Companion files. |
| `caniuse-lite` 1.0.30001810 | CC-BY-4.0 | Attribute the upstream data, link its license, retain supplied notices and identify modifications. |
| Noto Sans TTF bundled inside `@vercel/og/dist` | Font name table: copyright Google LLC, 2015–2021; license URL `http://scripts.sil.org/OFL` | Obtain the matching font's complete copyright/OFL notice and preserve it when redistributing the font; respect reserved-name restrictions for modified fonts. The package's MPL text does not cover the font by itself. |
| Dual-license packages | Exact SPDX expressions in inventory | Select and comply with a permitted branch of an OR expression; satisfy all applicable licenses in an AND expression. |

Primary license texts: [LGPLv3](https://www.gnu.org/licenses/lgpl-3.0.html),
[MPL 2.0](https://www.mozilla.org/en-US/MPL/2.0/),
[Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0),
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/legalcode.en),
[SIL OFL](https://openfontlicense.org/open-font-license-official-text/).
Use the exact shipped project's notices in addition to these license texts.

## Embedded native inventory

The audited `@img/sharp-libvips-darwin-arm64` package contains a compiled
`libvips-cpp.8.18.6.dylib`. Its README lists the following embedded libraries;
versions below come from its `versions.json`. This is a second inventory layer
beyond the npm package's single LGPL label.

| Library | Version | License reported by package |
| --- | --- | --- |
| aom | 3.15.0 | BSD-2-Clause plus Alliance for Open Media patent license |
| cairo | 1.18.4 | MPL-2.0 |
| cgif | 0.5.3 | MIT |
| expat | 2.8.3 | MIT |
| fontconfig | 2.18.3 | fontconfig BSD-like license |
| freetype | 2.14.3 | FreeType license |
| fribidi | 1.0.16 | LGPLv3 |
| glib | 2.89.4 | LGPLv3 |
| harfbuzz | 14.3.1 | MIT |
| highway | 1.4.0 | BSD-3-Clause |
| lcms | 2.19.1 | MIT |
| libarchive | 3.8.9 | BSD-2-Clause |
| libexif | 0.6.26 | LGPLv3 |
| libffi | 3.8.0 | MIT |
| libheif | 1.23.2 | LGPLv3 |
| libimagequant | 2.4.1 | BSD-2-Clause |
| libnsgif | not listed in versions.json | MIT |
| libpng | 1.6.58 | libpng license |
| librsvg | 2.62.91 | LGPLv3 |
| libtiff | 4.7.2 | libtiff BSD-like license |
| libultrahdr | 2.0.2 | MIT |
| libvips | 8.18.6 | LGPLv3 |
| libwebp | 1.6.0 | BSD |
| libxml2 | 2.15.3 | MIT |
| mozjpeg | 0826579 | zlib, IJG and BSD-3-Clause |
| pango | 1.58.2 | LGPLv3 |
| pixman | 0.46.4 | MIT |
| proxy-libintl | 0.5 | LGPLv3 |
| zlib-ng | 2.3.3 | zlib license |

Upstream build project: [sharp-libvips](https://github.com/lovell/sharp-libvips).
Resolve discrepancies and obtain exact source/build inputs for the shipped
package before assembling a source-compliance bundle. Other native executables,
WASM binaries and downloaded browser runtimes need their own embedded inventory;
the table above does not claim to cover them.

## Artwork provenance

The [asset inventory](licenses/2026-09-15-artwork.json) records each PNG's
SHA-256, dimensions and first-add commit.

- `public/icon-192.png` and `public/icon-512.png` first appear in commit `8828037`.
  Both depict the same simple C tile. On 2026-09-15 the maintainer confirmed:
  "yes, we generated them on codex." Origin is therefore recorded as
  maintainer-attested Codex generation, with no third-party asset source reported.
  The generation prompt/session/model and glyph construction are not retained in
  the repository, so this is an origin attestation rather than independent proof
  of copyright exclusivity or third-party clearance. The project's existing MIT
  notice applies to the repository assets to the extent the maintainer holds
  rights; AI generation does not justify inventing an upstream asset license.
- The 12 documentation PNGs are screenshots of Companion's own UI with
  demo/example/disposable data. Their creation commits were identified and the
  contact sheet reviewed. No visible credential was identified. This establishes
  content/provenance evidence, not independent rights to any third-party UI/font
  incorporated in a capture.

## Before shipping a bundled binary

Freeze the exact target OS/architecture and artifact contents. Regenerate the
inventory from that artifact, preserve each applicable notice, account for all
embedded libraries/fonts/runtimes, provide required corresponding source/build
materials, and test any required library replacement/relink path. Retain the icon
provenance record with that release. Source-repository
publication and binary-distribution approval are separate decisions.
