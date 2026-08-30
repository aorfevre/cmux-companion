# cmux companion

A private, mobile-first companion for [cmux](https://cmux.com). It runs on your Mac, stays on automatically, and lets your phone monitor or interact with cmux over your existing Tailscale network.

No cloud application server is involved. Terminal output and input travel directly between your phone and Mac.

## What it does

- Shows every cmux workspace and terminal
- Highlights sessions that are working or need attention
- Streams cmux activity and reconnects automatically
- Displays recent terminal output
- Sends prompts and a small, safe allow-list of terminal keys
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
cmux CLI → cmux Unix socket → cmux.app
```

The service binds only to `127.0.0.1`. Tailscale Serve is the only network-facing listener. The installer uses HTTPS port 8443 so it does not replace an existing Tailscale Serve handler on port 443.

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
- The CLI is spawned with argv arrays and never through a shell.
- Read-only protection is enabled by default on each phone.

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
npm run lint
npm run build
npm run test:live
npm run test:installed
```

`test:live` exercises the cmux adapter directly. `test:installed` sends the same read/control flow through the installed HTTP service. Both create an isolated cmux workspace and close it in cleanup; neither uses one of your existing sessions.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CMUX_BIN` | `/Applications/cmux.app/Contents/Resources/bin/cmux` | cmux CLI location |
| `CMUX_COMPANION_HOST` | `127.0.0.1` | Local bind address |
| `CMUX_COMPANION_PORT` | `3210` | Companion HTTP port |
| `CMUX_COMPANION_FRONTEND_PORT` | `3211` | Internal PWA server port |
| `CMUX_COMPANION_TAILSCALE_PORT` | `8443` | Private HTTPS port |
| `CMUX_COMPANION_TOKEN_FILE` | `~/.config/cmux-companion/token` | Pairing token path |

## Troubleshooting

- **Phone cannot connect:** confirm Tailscale is connected on both devices and run `npm run status`.
- **Waiting for cmux:** open cmux on the Mac. The companion will reconnect without a restart.
- **Mac is sleeping:** Tailscale and the companion cannot respond while macOS is asleep.
- **Logs:** inspect `~/Library/Logs/cmux-companion.log` and `~/Library/Logs/cmux-companion.error.log`.
- **Changed source after installation:** run `npm run install:mac` again to rebuild and restart.

## License

MIT
