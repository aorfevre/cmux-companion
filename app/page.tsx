"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

type Terminal = {
  id: string;
  title: string;
  current_directory?: string | null;
  is_focused?: boolean;
  is_ready?: boolean;
};

type Workspace = {
  id: string;
  title: string;
  current_directory?: string | null;
  has_unread?: boolean;
  is_selected?: boolean;
  last_activity_at?: number;
  preview?: string | null;
  terminals: Terminal[];
};

type Bootstrap = {
  connected: boolean;
  host: {
    mac_display_name?: string;
    workspace_count?: number;
    terminal_fidelity?: string;
  } | null;
  workspaces: Workspace[];
  error: string | null;
  refreshedAt: string;
};

type LiveEvent = { type: string; payload: Record<string, unknown>; receivedAt: number };
type View = "sessions" | "activity" | "settings";

const SPINNERS = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body as T;
}

function workspaceState(workspace: Workspace) {
  if (workspace.has_unread) return { label: "Needs you", tone: "attention" };
  if (workspace.terminals.some((terminal) => SPINNERS.includes(terminal.title?.[0] || ""))) {
    return { label: "Working", tone: "working" };
  }
  return { label: workspace.is_selected ? "Active" : "Ready", tone: "ready" };
}

function compactPath(path?: string | null) {
  if (!path) return "Directory unavailable";
  return path.replace(/^\/Users\/[^/]+/, "~");
}

function relativeTime(timestamp?: number) {
  if (!timestamp) return "now";
  const seconds = Math.max(0, Math.round(Date.now() / 1000 - timestamp));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export default function Home() {
  const [auth, setAuth] = useState<"loading" | "paired" | "unpaired" | "offline">("loading");
  const [pairingToken, setPairingToken] = useState("");
  const [pairingError, setPairingError] = useState("");
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [view, setView] = useState<View>("sessions");
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [selectedTerminalId, setSelectedTerminalId] = useState<string | null>(null);
  const [screen, setScreen] = useState("");
  const [screenError, setScreenError] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [live, setLive] = useState(false);
  const [readOnly, setReadOnly] = useState(() => {
    if (typeof window === "undefined") return true;
    return localStorage.getItem("cmux-companion-read-only") !== "false";
  });
  const [installPrompt, setInstallPrompt] = useState<Event & { prompt?: () => Promise<void> } | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectedWorkspace = useMemo(
    () => bootstrap?.workspaces.find((workspace) => workspace.id === selectedWorkspaceId) || null,
    [bootstrap, selectedWorkspaceId],
  );
  const selectedTerminal = selectedWorkspace?.terminals.find((terminal) => terminal.id === selectedTerminalId)
    || selectedWorkspace?.terminals[0]
    || null;

  const loadBootstrap = useCallback(async () => {
    try {
      const data = await api<Bootstrap>("/api/bootstrap");
      setBootstrap(data);
    } catch (error) {
      if (error instanceof Error && error.message.includes("Pair")) setAuth("unpaired");
      setBootstrap((current) => current ? { ...current, connected: false, error: "Waiting for cmux" } : null);
    }
  }, []);

  useEffect(() => {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
    const onInstall = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as Event & { prompt?: () => Promise<void> });
    };
    window.addEventListener("beforeinstallprompt", onInstall);
    api<{ paired: boolean }>("/api/auth/status")
      .then((status) => setAuth(status.paired ? "paired" : "unpaired"))
      .catch(() => setAuth("offline"));
    return () => window.removeEventListener("beforeinstallprompt", onInstall);
  }, []);

  useEffect(() => {
    if (auth !== "paired") return;
    const kickoff = window.setTimeout(loadBootstrap, 0);
    const poll = window.setInterval(() => {
      if (document.visibilityState === "visible") loadBootstrap();
    }, 8_000);

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/api/events`);
    socket.onopen = () => setLive(true);
    socket.onclose = () => setLive(false);
    socket.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data);
        setEvents((current) => [{ ...event, receivedAt: Date.now() }, ...current].slice(0, 80));
        if (event.type === "cmux:event") {
          if (refreshTimer.current) clearTimeout(refreshTimer.current);
          refreshTimer.current = setTimeout(loadBootstrap, 350);
        }
      } catch {
        // Ignore malformed frames; the reconnectable cmux stream continues.
      }
    };
    return () => {
      clearInterval(poll);
      clearTimeout(kickoff);
      socket.close();
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [auth, loadBootstrap]);

  const loadScreen = useCallback(async () => {
    if (!selectedTerminal) return;
    try {
      const result = await api<{ text: string }>(`/api/terminals/${selectedTerminal.id}/screen?lines=320`);
      setScreen(result.text || "No terminal output yet.");
      setScreenError("");
    } catch (error) {
      setScreenError(error instanceof Error ? error.message : "Unable to read this terminal");
    }
  }, [selectedTerminal]);

  useEffect(() => {
    if (!selectedTerminal) return;
    const kickoff = window.setTimeout(loadScreen, 0);
    const poll = window.setInterval(() => {
      if (document.visibilityState === "visible") loadScreen();
    }, 1_500);
    return () => {
      clearTimeout(kickoff);
      clearInterval(poll);
    };
  }, [selectedTerminal, loadScreen]);

  async function pair(event: FormEvent) {
    event.preventDefault();
    setPairingError("");
    try {
      await api("/api/auth/pair", {
        method: "POST",
        body: JSON.stringify({ token: pairingToken.trim() }),
      });
      setPairingToken("");
      setAuth("paired");
    } catch (error) {
      setPairingError(error instanceof Error ? error.message : "Pairing failed");
    }
  }

  function openWorkspace(workspace: Workspace) {
    setSelectedWorkspaceId(workspace.id);
    setSelectedTerminalId(workspace.terminals.find((terminal) => terminal.is_focused)?.id || workspace.terminals[0]?.id || null);
  }

  async function sendPrompt(event: FormEvent) {
    event.preventDefault();
    if (!selectedTerminal || !draft.trim() || readOnly) return;
    setSending(true);
    try {
      await api(`/api/terminals/${selectedTerminal.id}/input`, {
        method: "POST",
        body: JSON.stringify({ text: draft, enter: true }),
      });
      setDraft("");
      setTimeout(loadScreen, 250);
    } finally {
      setSending(false);
    }
  }

  async function sendKey(key: string) {
    if (!selectedTerminal || readOnly) return;
    setSending(true);
    try {
      await api(`/api/terminals/${selectedTerminal.id}/key`, {
        method: "POST",
        body: JSON.stringify({ key }),
      });
      setTimeout(loadScreen, 200);
    } finally {
      setSending(false);
    }
  }

  function changeReadOnly(value: boolean) {
    setReadOnly(value);
    localStorage.setItem("cmux-companion-read-only", String(value));
  }

  if (auth === "loading") return <LoadingScreen />;
  if (auth === "unpaired" || auth === "offline") {
    return (
      <PairScreen
        offline={auth === "offline"}
        token={pairingToken}
        error={pairingError}
        onToken={setPairingToken}
        onPair={pair}
        onRetry={() => location.reload()}
      />
    );
  }

  if (selectedWorkspace && selectedTerminal) {
    return (
      <TerminalView
        workspace={selectedWorkspace}
        terminal={selectedTerminal}
        screen={screen}
        screenError={screenError}
        draft={draft}
        sending={sending}
        readOnly={readOnly}
        onBack={() => {
          setSelectedWorkspaceId(null);
          setSelectedTerminalId(null);
          setScreen("");
        }}
        onTerminal={setSelectedTerminalId}
        onDraft={setDraft}
        onSubmit={sendPrompt}
        onKey={sendKey}
        onReadOnly={() => changeReadOnly(!readOnly)}
        onRefresh={loadScreen}
      />
    );
  }

  return (
    <main className="app-shell">
      <Header
        connected={Boolean(bootstrap?.connected)}
        live={live}
        device={bootstrap?.host?.mac_display_name || "Your Mac"}
        onSettings={() => setView("settings")}
      />

      {view === "sessions" && (
        <SessionsView bootstrap={bootstrap} onOpen={openWorkspace} onRefresh={loadBootstrap} />
      )}
      {view === "activity" && <ActivityView events={events} />}
      {view === "settings" && (
        <SettingsView
          bootstrap={bootstrap}
          readOnly={readOnly}
          installable={Boolean(installPrompt)}
          onReadOnly={changeReadOnly}
          onInstall={() => installPrompt?.prompt?.()}
          onLogout={async () => {
            await api("/api/auth/logout", { method: "POST", body: "{}" });
            setAuth("unpaired");
          }}
        />
      )}

      <BottomNav view={view} onView={setView} attention={bootstrap?.workspaces.some((workspace) => workspace.has_unread) || false} />
    </main>
  );
}

function Header({ connected, live, device, onSettings }: {
  connected: boolean;
  live: boolean;
  device: string;
  onSettings: () => void;
}) {
  return (
    <header className="topbar">
      <div className="brand-mark" aria-hidden="true">c</div>
      <div className="brand-copy">
        <strong>cmux companion</strong>
        <span><i className={`connection-dot ${connected ? "" : "offline"}`} /> {connected ? device : "Waiting for cmux"}</span>
      </div>
      <button className="live-badge" aria-label={live ? "Live updates connected" : "Live updates reconnecting"}>
        {live ? "LIVE" : "SYNC"}
      </button>
      <button className="icon-button" onClick={onSettings} aria-label="Open settings">•••</button>
    </header>
  );
}

function SessionsView({ bootstrap, onOpen, onRefresh }: {
  bootstrap: Bootstrap | null;
  onOpen: (workspace: Workspace) => void;
  onRefresh: () => void;
}) {
  const workspaces = bootstrap?.workspaces || [];
  const needsYou = workspaces.filter((workspace) => workspace.has_unread).length;
  const working = workspaces.filter((workspace) => workspaceState(workspace).tone === "working").length;
  return (
    <>
      <section className="hero">
        <p className="eyebrow">{bootstrap?.connected ? "LIVE FROM YOUR MAC" : "LOCAL COMPANION"}</p>
        <h1>{bootstrap?.connected ? (needsYou ? "One session needs you." : "Everything is moving.") : "Waiting for cmux."}</h1>
        <p>{bootstrap?.connected
          ? "Keep an eye on your sessions and step in only when they need you."
          : "The companion stays ready and reconnects automatically as soon as cmux opens."}</p>
        <div className="summary-row" aria-label="Session summary">
          <div><strong>{workspaces.length}</strong><span>sessions</span></div>
          <div><strong className="accent-number">{needsYou}</strong><span>needs you</span></div>
          <div><strong>{working}</strong><span>working</span></div>
        </div>
      </section>

      <section className="workspace-section">
        <div className="section-heading">
          <h2>Workspaces</h2>
          <button className="text-button" onClick={onRefresh}>Refresh</button>
        </div>
        {!bootstrap && <WorkspaceSkeleton />}
        {bootstrap && workspaces.length === 0 && (
          <div className="empty-card">
            <span>⌁</span>
            <strong>No cmux workspaces yet</strong>
            <p>Open a workspace on your Mac. It will appear here automatically.</p>
          </div>
        )}
        <div className="workspace-list">
          {workspaces.map((workspace) => {
            const state = workspaceState(workspace);
            const terminal = workspace.terminals.find((item) => item.is_focused) || workspace.terminals[0];
            return (
              <button className="workspace-card" key={workspace.id} onClick={() => onOpen(workspace)}>
                <div className="workspace-card-head">
                  <span className={`status-orb ${state.tone}`} aria-hidden="true" />
                  <div>
                    <strong>{workspace.title || "Untitled workspace"}</strong>
                    <span>{compactPath(workspace.current_directory || terminal?.current_directory)}</span>
                  </div>
                  <time>{relativeTime(workspace.last_activity_at)}</time>
                </div>
                <p>{workspace.preview || terminal?.title || "Terminal ready"}</p>
                <div className="card-foot">
                  <span className={`state-pill ${state.tone}`}>{state.label}</span>
                  <span className="terminal-count">{workspace.terminals.length} terminal{workspace.terminals.length === 1 ? "" : "s"}</span>
                  <span className="open-label">Open <b>›</b></span>
                </div>
              </button>
            );
          })}
        </div>
      </section>
    </>
  );
}

function TerminalView(props: {
  workspace: Workspace;
  terminal: Terminal;
  screen: string;
  screenError: string;
  draft: string;
  sending: boolean;
  readOnly: boolean;
  onBack: () => void;
  onTerminal: (id: string) => void;
  onDraft: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onKey: (key: string) => void;
  onReadOnly: () => void;
  onRefresh: () => void;
}) {
  const screenRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const element = screenRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [props.screen]);

  return (
    <main className="terminal-shell">
      <header className="terminal-header">
        <button className="back-button" onClick={props.onBack} aria-label="Back to sessions">‹</button>
        <div>
          <strong>{props.workspace.title}</strong>
          <span>{props.terminal.title}</span>
        </div>
        <button className={`lock-button ${props.readOnly ? "" : "unlocked"}`} onClick={props.onReadOnly}>
          {props.readOnly ? "Read only" : "Unlocked"}
        </button>
      </header>

      {props.workspace.terminals.length > 1 && (
        <div className="terminal-tabs" role="tablist">
          {props.workspace.terminals.map((terminal, index) => (
            <button
              role="tab"
              aria-selected={terminal.id === props.terminal.id}
              className={terminal.id === props.terminal.id ? "active" : ""}
              onClick={() => props.onTerminal(terminal.id)}
              key={terminal.id}
            >
              {index + 1}. {terminal.title}
            </button>
          ))}
        </div>
      )}

      <section className="terminal-window">
        <div className="terminal-chrome">
          <span /><span /><span />
          <p>{compactPath(props.terminal.current_directory || props.workspace.current_directory)}</p>
          <button onClick={props.onRefresh} aria-label="Refresh terminal">↻</button>
        </div>
        {props.screenError
          ? <div className="terminal-error">{props.screenError}</div>
          : <pre ref={screenRef}>{props.screen || "Reading terminal…"}</pre>}
      </section>

      <div className="quick-keys" aria-label="Terminal keys">
        {[
          ["Esc", "escape"], ["Tab", "tab"], ["↑", "up"], ["↓", "down"],
          ["Ctrl-C", "ctrl+c"], ["Enter", "enter"],
        ].map(([label, key]) => (
          <button disabled={props.readOnly || props.sending} onClick={() => props.onKey(key)} key={key}>{label}</button>
        ))}
      </div>

      <form className="composer" onSubmit={props.onSubmit}>
        {props.readOnly && <p>Read-only protection is on. Tap “Read only” above to enable input.</p>}
        <textarea
          aria-label="Message to terminal"
          placeholder={props.readOnly ? "Unlock input to interact…" : "Reply or ask the agent…"}
          value={props.draft}
          onChange={(event) => props.onDraft(event.target.value)}
          disabled={props.readOnly || props.sending}
          rows={2}
        />
        <button disabled={props.readOnly || props.sending || !props.draft.trim()}>{props.sending ? "…" : "↑"}</button>
      </form>
    </main>
  );
}

function ActivityView({ events }: { events: LiveEvent[] }) {
  return (
    <section className="subpage">
      <p className="eyebrow">EVENT STREAM</p>
      <h1>Activity</h1>
      <p className="subpage-intro">Live changes from cmux appear here while the companion is open.</p>
      <div className="activity-list">
        {events.length === 0 && <div className="empty-card"><span>◉</span><strong>No new activity</strong><p>Events will arrive automatically.</p></div>}
        {events.map((event, index) => (
          <article key={`${event.receivedAt}-${index}`}>
            <i />
            <div>
              <strong>{String(event.payload?.name || event.type).replaceAll(".", " ")}</strong>
              <span>{new Date(event.receivedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function SettingsView({ bootstrap, readOnly, installable, onReadOnly, onInstall, onLogout }: {
  bootstrap: Bootstrap | null;
  readOnly: boolean;
  installable: boolean;
  onReadOnly: (value: boolean) => void;
  onInstall: () => void;
  onLogout: () => void;
}) {
  return (
    <section className="subpage">
      <p className="eyebrow">COMPANION</p>
      <h1>Settings</h1>
      <div className="settings-list">
        <div className="setting-row">
          <div><strong>Connection</strong><span>{bootstrap?.connected ? bootstrap.host?.mac_display_name || "Connected to cmux" : "Waiting for cmux"}</span></div>
          <i className={bootstrap?.connected ? "good" : ""}>{bootstrap?.connected ? "Online" : "Offline"}</i>
        </div>
        <div className="setting-row">
          <div><strong>Read-only protection</strong><span>Prevent accidental terminal input from your phone.</span></div>
          <label htmlFor="read-only-protection">
            <span className="sr-only">Read-only protection</span>
            <input id="read-only-protection" type="checkbox" checked={readOnly} onChange={(event) => onReadOnly(event.target.checked)} />
          </label>
        </div>
        <button className="setting-row" onClick={onInstall} disabled={!installable}>
          <div><strong>Install on Home Screen</strong><span>{installable ? "Use cmux companion like a native app." : "Use Safari’s Share → Add to Home Screen."}</span></div>
          <b>›</b>
        </button>
        <button className="setting-row danger" onClick={onLogout}>
          <div><strong>Unpair this phone</strong><span>The pairing code will be required again.</span></div>
          <b>›</b>
        </button>
      </div>
      <p className="privacy-note">Terminal content travels directly between this device and your Mac over your private Tailscale network.</p>
    </section>
  );
}

function BottomNav({ view, onView, attention }: { view: View; onView: (view: View) => void; attention: boolean }) {
  return (
    <nav className="bottom-nav" aria-label="Primary navigation">
      <button className={view === "sessions" ? "active" : ""} onClick={() => onView("sessions")}><span>⌁</span>Sessions</button>
      <button className={view === "activity" ? "active" : ""} onClick={() => onView("activity")}><span className="nav-icon">◉{attention && <i />}</span>Activity</button>
      <button className={view === "settings" ? "active" : ""} onClick={() => onView("settings")}><span>⚙</span>Settings</button>
    </nav>
  );
}

function PairScreen({ offline, token, error, onToken, onPair, onRetry }: {
  offline: boolean;
  token: string;
  error: string;
  onToken: (value: string) => void;
  onPair: (event: FormEvent) => void;
  onRetry: () => void;
}) {
  return (
    <main className="pair-shell">
      <div className="pair-visual"><div className="brand-mark large">c</div><i /><i /><div className="phone-shape">⌁</div></div>
      <p className="eyebrow">{offline ? "COMPANION UNREACHABLE" : "PRIVATE DEVICE PAIRING"}</p>
      <h1>{offline ? "Your Mac isn’t reachable yet." : "Connect this phone."}</h1>
      <p>{offline
        ? "Check that Tailscale is connected and the companion is running on your Mac."
        : "Enter the one-time pairing code shown by the installer on your Mac."}</p>
      {offline ? (
        <button className="primary-button" onClick={onRetry}>Try again</button>
      ) : (
        <form onSubmit={onPair}>
          <input
            type="password"
            autoComplete="one-time-code"
            spellCheck={false}
            value={token}
            onChange={(event) => onToken(event.target.value)}
            placeholder="Pairing code"
            aria-label="Pairing code"
            required
          />
          <button className="primary-button">Pair securely</button>
          {error && <p className="form-error">{error}</p>}
        </form>
      )}
      <small>Direct over Tailscale · No public internet exposure</small>
    </main>
  );
}

function LoadingScreen() {
  return <main className="loading-screen"><div className="brand-mark large">c</div><span>Connecting to your Mac…</span></main>;
}

function WorkspaceSkeleton() {
  return <div className="workspace-list"><div className="workspace-card skeleton" /><div className="workspace-card skeleton" /></div>;
}
