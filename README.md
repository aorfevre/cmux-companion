# cmux companion

A private, mobile-first companion for [cmux](https://cmux.com). It runs on your Mac, stays on automatically, and lets your phone monitor or interact with cmux over your existing Tailscale network.

No cloud application server is involved. Terminal output and input travel directly between your phone and Mac.

## What it does

- Shows every cmux workspace and terminal
- Highlights real cmux status, structured tasks, CPU, memory, and process health
- Collects permission requests, questions, plans, and meaningful notifications in an action inbox
- Launches allow-listed local repositories through the configured `xcodex` or `xclaude` aliases, a shell, or a declared package script
- Reviews staged, unstaged, and untracked Git changes and per-file diffs
- Shows the current branch's open pull request, review decision, and check status directly inside its session
- Sends contextual Web Push alerts for decisions, failures, completion, PR changes, and detected local apps
- Opens each decision notification on a focused approval or reply card instead of a generic terminal
- Makes terminal `.md` references tappable and renders safe repository Markdown, tables, code, and local images on mobile
- Detects localhost apps and creates explicit, tailnet-only Tailscale Serve links from a private Apps screen
- Streams cmux activity and reconnects automatically with exponential backoff
- Renders cmux's native terminal replay grid with exact colors, styles, cursor, cell geometry, and scrollback
- Opens terminals at the latest output, follows only near the bottom, and preserves scrollback while reading
- Provides persistent terminal text-size controls, readable 16px input, and pinch zoom on mobile
- Keeps one mobile composer visible and accepts pasted or photo-library images as private local agent attachments
- Keeps secondary navigation, PR details, display options, shortcuts, and special keys in one session menu
- Auto-grows short messages and provides a focused full-screen editor for long prompts
- Sends prompts and a small, safe allow-list of terminal keys
- Provides a searchable, provider-labelled `/` shortcut palette for common Codex and Claude workflows
- Restarts a stuck terminal or closes a workspace with explicit confirmation
- Starts in read-only mode to avoid accidental phone input
- Installs as a standalone PWA on iPhone
- Waits quietly when cmux is closed and reconnects when it opens
- Starts automatically at macOS login through a LaunchAgent

## Architecture

```text
iPhone PWA
    │ private HTTPS + WebSocket
    ▼
Tailscale Serve :8443
    │ loopback proxy
    ▼
cmux companion :3210
    │ allow-listed argv calls
    ▼
cmux CLI → replay grid / safe input RPCs → cmux Unix socket → cmux.app
```

The service binds only to `127.0.0.1`. Tailscale Serve is the only network-facing listener. The installer uses HTTPS port 8443 so it does not replace an existing Tailscale Serve handler on port 443.

Local app previews use separate HTTPS ports from 8500 through 8599. This preserves application root paths, redirects, assets, and WebSockets better than path-prefix proxying. A detected app is not exposed until you tap **Make private link**; links remain tailnet-only and Companion never enables Tailscale Funnel.

By default, the phone reflows the full Mac-width replay grid locally, keeping the Mac terminal unchanged while preserving enough history to scroll. The **Fit** control switches between this readable phone layout and the exact terminal grid. Older cmux versions automatically fall back to the authenticated plain-text screen endpoint.

The installer also enables cmux’s supported password-protected automation mode. It creates a separate socket credential at `~/.config/cmux-companion/cmux-socket-password` and makes a timestamped `cmux.json.*.bak` before changing cmux configuration.

## Requirements

- macOS with cmux installed in `/Applications/cmux.app`
- Node.js 22.13 or later
- Tailscale connected on both the Mac and phone

## Install

```bash
npm run install:mac
```

The installer builds the PWA, installs the macOS LaunchAgent, starts the companion, and configures private Tailscale HTTPS access on port 8443.

Show the phone URL and pairing code:

```bash
npm run status -- --show-token
```

Open the URL on your phone, enter the pairing code, then use Safari’s **Share → Add to Home Screen**.

The pairing code is stored with mode `0600` at `~/.config/cmux-companion/token`.

## Daily use

There is nothing to launch. The lightweight companion starts at login and remains ready. If cmux is not open, the phone UI displays “Waiting for cmux” and reconnects automatically when cmux starts.

```bash
npm run status
npm run status -- --show-token
npm run install:mac
npm run uninstall:mac
```

The uninstall command removes automatic startup but deliberately preserves the pairing token and Tailscale Serve configuration.

## Security model

- The HTTP service listens on loopback only.
- Tailscale Serve provides private HTTPS transport and tailnet identity headers.
- Tailscale membership alone is not enough: every browser must also pair.
- The browser receives an HttpOnly, SameSite=Strict session cookie.
- State-changing requests enforce same-origin checks.
- cmux identifiers must be full UUIDs.
- Terminal input, keys, and text length are explicitly validated.
- No route accepts a shell command, arbitrary cmux arguments, or arbitrary RPC.
- Repository launch is restricted to immediate Git repositories in configured roots; package scripts must come from that repository's `package.json`.
- Git diff requests are restricted to files currently reported as changed, and untracked symlink content is hidden.
- The CLI is spawned with argv arrays and never through a shell.
- Read-only protection is enabled by default on each phone.
- Push subscriptions and VAPID keys stay in a mode-`0600` file on the Mac; notification content is hidden by default.
- Alert categories, quiet hours, persistent deduplication, and lock-screen privacy are configurable per phone.
- Markdown reads are restricted to regular `.md`/`.markdown` files inside allow-listed repositories; canonical paths block traversal and out-of-repo symlinks, rendered HTML is not executed, and local images are type and size restricted.
- Preview targets must be localhost TCP ports. Tailscale HTTPS ports are allocated from a bounded range, can be stopped from the Apps screen, and are never exposed with Funnel.
- Pasted images are magic-byte validated, limited to 8 MB, stored with mode `0600`, and removed automatically after seven days.

Treat a paired phone as privileged: unlocking terminal input gives it control of interactive processes running in cmux.

## Development

Run the bridge and frontend in separate terminals:

```bash
CMUX_COMPANION_TOKEN=development-token-at-least-32-characters npm run companion:dev
npm run dev
```

Then open `http://localhost:3000` and pair using the development token.

Verification:

```bash
npm test
npm run test:ui
npm run lint
npm run typecheck
npm run build
npm run test:live
npm run test:installed
npm run test:preview-live
```

`test:live` exercises the cmux adapter directly. `test:installed` sends the same read/control flow through the installed HTTP service. Both create an isolated cmux workspace and close it in cleanup; neither uses one of your existing sessions.

`test:preview-live` starts a temporary loopback HTTP server, exposes it through an unused private Tailscale Serve port, verifies HTTPS access, and removes the Serve handler in cleanup.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CMUX_BIN` | `/Applications/cmux.app/Contents/Resources/bin/cmux` | cmux CLI location |
| `CMUX_COMPANION_HOST` | `127.0.0.1` | Local bind address |
| `CMUX_COMPANION_PORT` | `3210` | Companion HTTP port |
| `CMUX_COMPANION_FRONTEND_PORT` | `3211` | Internal PWA server port |
| `CMUX_COMPANION_TAILSCALE_PORT` | `8443` | Private HTTPS port |
| `CMUX_COMPANION_TAILSCALE_BIN` | Tailscale macOS app CLI, then `tailscale` | CLI used to manage private preview links |
| `CMUX_COMPANION_TOKEN_FILE` | `~/.config/cmux-companion/token` | Pairing token path |
| `CMUX_COMPANION_REPO_ROOTS` | `~/Developers/karven:~/Developers/rekord` (expanded defaults for this install) | Colon-separated repository roots |
| `CMUX_COMPANION_PUSH_FILE` | `~/.config/cmux-companion/push.json` | Private push keys and device subscriptions |
| `CMUX_COMPANION_PREVIEWS_FILE` | `~/.config/cmux-companion/previews.json` | Managed private preview registry |
| `CMUX_COMPANION_PREVIEW_PORT_START` | `8500` | First Tailscale HTTPS preview port |
| `CMUX_COMPANION_PREVIEW_PORT_END` | `8599` | Last Tailscale HTTPS preview port |

## Troubleshooting

- **Phone cannot connect:** confirm Tailscale is connected on both devices and run `npm run status`.
- **Waiting for cmux:** open cmux on the Mac. The companion will reconnect without a restart.
- **Mac is sleeping:** Tailscale and the companion cannot respond while macOS is asleep.
- **Logs:** inspect `~/Library/Logs/cmux-companion.log` and `~/Library/Logs/cmux-companion.error.log`.
- **Changed source after installation:** run `npm run install:mac` again to rebuild and restart.

## License

MIT
