import { DEFAULT_MODEL_ROLES } from "../../server/model-options.mjs";

const now = "2026-09-08T09:00:00.000Z";
const endpoint = "https://push.example.test/subscriptions/fixture-device";
const publicKey = "Y3lwcmVzcy12YXBpZC1wdWJsaWMta2V5LWZpeHR1cmU";
const defaultSettings = { attention: true, completion: true, failure: true, pullRequest: true, preview: true, hideContent: true, quietEnabled: false, quietStart: "22:00", quietEnd: "08:00" };
type AlertSettings = typeof defaultSettings;

type FakeSubscription = { endpoint: string; toJSON: () => Record<string, unknown>; unsubscribe: () => Promise<boolean> };
type PushWindow = Window & { PushManager?: unknown; Notification?: unknown; pushFixture?: { subscription: FakeSubscription | null; subscribed: number; unsubscribed: number; permissionRequests: number } };

// Stub only the browser push primitives the settings card touches. The fake
// registration resolves immediately because the support file blocks sw.js.
function stubPush(win: PushWindow, existing: boolean) {
  const subscription: FakeSubscription = {
    endpoint,
    toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: "fixture-p256dh", auth: "fixture-auth" } }),
    unsubscribe: () => { win.pushFixture!.unsubscribed += 1; win.pushFixture!.subscription = null; return Promise.resolve(true); },
  };
  win.pushFixture = { subscription: existing ? subscription : null, subscribed: 0, unsubscribed: 0, permissionRequests: 0 };
  const pushManager = {
    getSubscription: () => Promise.resolve(win.pushFixture!.subscription),
    subscribe: (options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }) => {
      expect(options.userVisibleOnly).to.equal(true);
      expect(options.applicationServerKey).to.have.length(32);
      win.pushFixture!.subscribed += 1; win.pushFixture!.subscription = subscription;
      return Promise.resolve(subscription);
    },
  };
  Object.defineProperty(win.navigator, "serviceWorker", { configurable: true, value: { register: () => Promise.resolve(), ready: Promise.resolve({ pushManager }) } });
  Object.defineProperty(win, "PushManager", { configurable: true, value: function PushManager() {} });
  Object.defineProperty(win, "Notification", { configurable: true, value: { permission: "default", requestPermission: () => { win.pushFixture!.permissionRequests += 1; return Promise.resolve("granted"); } } });
}

function fixtures() {
  let subscribed = false;
  let settings: AlertSettings = { ...defaultSettings };
  cy.intercept("**/api/**", { statusCode: 501, body: { error: "Missing deterministic Cypress API fixture" } });
  cy.intercept("GET", "**/api/settings/local", { statusCode: 404, body: { error: "Legacy settings" } });
  cy.intercept("GET", "**/api/auth/status", { paired: true });
  cy.intercept("GET", "**/api/bootstrap", { connected: true, host: { mac_display_name: "Settings Mac" }, workspaces: [], error: null, refreshedAt: now }).as("bootstrap");
  cy.intercept("GET", "**/api/inbox", { items: [], actionableCount: 0, unreadCount: 0 });
  cy.intercept("GET", "**/api/repos", { repos: [] });
  cy.intercept("GET", "**/api/health", { version: { builtAt: now } });
  cy.intercept("GET", "**/api/updater/status", { available: false });
  cy.intercept("GET", "**/api/settings/models", { roles: DEFAULT_MODEL_ROLES, defaults: DEFAULT_MODEL_ROLES, warning: null }).as("models");
  cy.intercept("GET", "**/api/previews", { previews: [] }).as("previews");
  cy.intercept("GET", "**/api/account-usage*", { generatedAt: now, source: "CCS", available: true, summary: { ready: 0, low: 0, exhausted: 0, reconnect: 0, unavailable: 0 }, providers: [] }).as("usage");
  cy.intercept("GET", "**/api/goals/capacity*", { providers: [], next: null, available: false });
  cy.intercept("GET", "**/api/goals/health", { sessionsAvailable: true, goals: [], summary: { goals: 0, tasks: 0, stuck: 0, needsYou: 0, working: 0 } });
  cy.intercept("GET", "**/api/goals/sessions/retirable*", { sessionsAvailable: true, closed: [], kept: [], failed: [] });
  cy.intercept("GET", "**/api/github-issues", { syncedAt: null, issues: [] });
  cy.intercept("GET", "**/api/worktree-plans*", { plans: [] });
  cy.intercept("GET", "**/api/worktree-dashboard*", { generatedAt: now, github: { status: "ready" }, summary: { repositories: 0, worktrees: 0, releases: 0, sessions: 0, needsYou: 0, working: 0, dirty: 0, pullRequests: 0 }, repositories: [], orphanSessions: [] });
  cy.intercept("GET", "**/api/push/status*", (request) => {
    const known = subscribed && request.query.endpoint === endpoint;
    request.reply({ supported: true, publicKey, subscriptionCount: subscribed ? 1 : 0, subscribed: known, settings: known ? settings : defaultSettings });
  }).as("pushStatus");
  cy.intercept("POST", "**/api/push/subscribe", (request) => {
    subscribed = true; settings = { ...defaultSettings };
    request.reply({ supported: true, publicKey, subscriptionCount: 1, subscribed: true, settings });
  }).as("subscribe");
  cy.intercept("POST", "**/api/push/settings", (request) => {
    settings = { ...request.body.settings };
    request.reply({ supported: true, publicKey, subscriptionCount: 1, subscribed: true, settings });
  }).as("saveSettings");
  cy.intercept("POST", "**/api/push/unsubscribe", (request) => { subscribed = false; request.reply({ subscribed: false }); }).as("unsubscribe");
  cy.intercept("POST", "**/api/push/test", { sent: 1, failed: 0, skipped: 0, error: null }).as("testAlert");
  return { markSubscribed: () => { subscribed = true; } };
}

function visitSettings(options: { push?: "none" | "fresh" | "existing"; readOnly?: string | null } = {}) {
  cy.visit(options.push ? "/settings#notifications" : "/settings#general", { onBeforeLoad(win) {
    if (options.readOnly !== undefined && options.readOnly !== null) win.localStorage.setItem("cmux-companion-read-only", options.readOnly);
    if (options.push === "fresh" || options.push === "existing") stubPush(win as PushWindow, options.push === "existing");
    else delete (win as PushWindow).PushManager;
  } });
  if (!options.push) cy.wait("@bootstrap");
  cy.findByRole("heading", { name: "Settings" }).should("be.visible");
}

for (const [width, height] of [[390, 844], [1440, 900]]) {
  describe(`Settings at ${width}px`, () => {
    beforeEach(() => cy.viewport(width, height));

    it("defaults to read-only protection and persists the toggle across a reload", () => {
      fixtures();
      visitSettings();
      cy.findByLabelText(/Protect terminal input/).should("be.checked");
      cy.contains(".preference-row", "Connected Mac").should("contain.text", "Settings Mac");
      cy.findByLabelText(/Protect terminal input/).uncheck();
      cy.window().its("localStorage").invoke("getItem", "cmux-companion-read-only").should("eq", "false");
      cy.reload();
      cy.findByLabelText(/Protect terminal input/).should("not.be.checked");
      cy.findByLabelText(/Protect terminal input/).check();
      cy.window().its("localStorage").invoke("getItem", "cmux-companion-read-only").should("eq", "true");
      cy.reload();
      cy.findByLabelText(/Protect terminal input/).should("be.checked");
    });

    it("opens Licence usage and Local apps from Settings and comes back", () => {
      fixtures();
      visitSettings();
      cy.visit("/settings#agents");
      cy.findByRole("link", { name: "View account usage" }).click();
      cy.location("search").should("eq", "?view=usage");
      cy.wait("@usage");
      cy.findByRole("heading", { name: "Licence usage" }).should("be.visible");
      cy.findByRole("button", { name: "‹ Settings" }).click();
      cy.location("pathname").should("eq", "/settings");
      cy.findByRole("heading", { name: "Settings" }).should("be.visible");
      cy.visit("/settings#advanced");
      cy.findByRole("link", { name: "Local apps and preview links" }).click();
      cy.location("search").should("eq", "?view=apps");
      cy.wait("@previews");
      cy.findByRole("heading", { name: "Local apps" }).should("be.visible");
      cy.findByRole("navigation", { name: "Main navigation" }).findByRole("link", { name: "Settings" }).click();
      cy.location("pathname").should("eq", "/settings");
      cy.findByRole("heading", { name: "Settings" }).should("be.visible");
    });
  });
}

describe("Settings install prompt", () => {
  beforeEach(() => cy.viewport(390, 844));

  it("hides the home-screen button until the browser offers installation", () => {
    fixtures();
    visitSettings();
    cy.findByRole("button", { name: "Add companion to home screen" }).should("not.exist");
    cy.window().then((win) => {
      const event = new win.Event("beforeinstallprompt", { cancelable: true }) as Event & { prompt?: () => Promise<void> };
      event.prompt = cy.stub().resolves();
      cy.wrap(event.prompt).as("installPrompt");
      win.dispatchEvent(event);
      expect(event.defaultPrevented).to.equal(true);
    });
    cy.findByRole("button", { name: "Add companion to home screen" }).click();
    cy.get("@installPrompt").should("have.been.calledOnce");
  });
});

describe("Background alerts", () => {
  beforeEach(() => cy.viewport(390, 844));

  it("explains the Home Screen requirement when push is unsupported", () => {
    fixtures();
    visitSettings({ push: "none" });
    cy.contains(".push-card", "Background alerts").within(() => {
      cy.findByRole("button", { name: "Enable" }).should("be.disabled");
      cy.contains("On iPhone, add this web app to your Home Screen first, then open it there to enable push alerts.").should("be.visible");
    });
    cy.get("@pushStatus.all").should("have.length", 0);
  });

  it("enables alerts, saves each preference, sends a test and disables again", () => {
    fixtures();
    visitSettings({ push: "fresh" });
    cy.wait("@pushStatus").its("request.url").should("not.include", "endpoint=");
    cy.contains(".push-card", "Background alerts").as("card");
    cy.get("@card").findByRole("button", { name: "Enable" }).should("be.enabled").click();
    cy.wait("@pushStatus").its("request.url").should("not.include", "endpoint=");
    cy.wait("@subscribe").its("request.body").should("deep.equal", { subscription: { endpoint, expirationTime: null, keys: { p256dh: "fixture-p256dh", auth: "fixture-auth" } } });
    cy.wait("@pushStatus").its("request.url").should("include", `endpoint=${encodeURIComponent(endpoint)}`);
    cy.get("[role=status]").should("contain.text", "Background alerts enabled");
    cy.window().its("pushFixture").should("deep.include", { subscribed: 1, permissionRequests: 1 });
    cy.get("@card").findByRole("button", { name: "Disable" }).should("be.visible");
    cy.findByLabelText(/^Failures/).should("be.checked").uncheck();
    cy.wait("@saveSettings").its("request.body").should("deep.equal", { endpoint, settings: { ...defaultSettings, failure: false } });
    cy.findByLabelText(/^Quiet hours/).check();
    cy.wait("@saveSettings").its("request.body.settings.quietEnabled").should("equal", true);
    cy.findByLabelText("From").should("have.value", "22:00");
    cy.findByLabelText("Until").should("have.value", "08:00").type("07:30");
    cy.findByLabelText("Until").should("have.value", "07:30");
    cy.get("@saveSettings.all").its("length").should("be.gte", 3);
    cy.get("@saveSettings.all").then((calls) => {
      const bodies = (calls as unknown as Array<{ request: { body: { settings: AlertSettings } } }>).map((call) => call.request.body.settings);
      expect(bodies[bodies.length - 1]).to.deep.equal({ ...defaultSettings, failure: false, quietEnabled: true, quietEnd: "07:30" });
    });
    cy.findByRole("button", { name: "Send test alert" }).click();
    cy.wait("@testAlert").its("request.body").should("deep.equal", { endpoint });
    cy.get("[role=status]").should("contain.text", "Test alert delivered");
    cy.get("@card").findByRole("button", { name: "Disable" }).click();
    cy.wait("@unsubscribe").its("request.body").should("deep.equal", { endpoint });
    cy.window().its("pushFixture.unsubscribed").should("equal", 1);
    cy.get("@card").findByRole("button", { name: "Enable" }).should("be.visible");
    cy.findByLabelText(/^Failures/).should("not.exist");
  });

  it("restores the saved preference when the server rejects a change", () => {
    const state = fixtures();
    state.markSubscribed();
    cy.intercept("POST", "**/api/push/settings", { statusCode: 500, body: { error: "Alert settings could not be saved" } }).as("rejectedSettings");
    visitSettings({ push: "existing" });
    cy.wait("@pushStatus").its("request.url").should("include", "endpoint=");
    cy.findByLabelText(/^Agent completed/).should("be.checked").uncheck();
    cy.wait("@rejectedSettings");
    cy.get("[role=status]").should("contain.text", "Alert settings could not be saved");
    cy.findByLabelText(/^Agent completed/).should("be.checked");
  });

  it("keeps alerts disabled and reports the failure when subscribing is refused", () => {
    fixtures();
    cy.intercept("POST", "**/api/push/subscribe", { statusCode: 503, body: { error: "Push alerts are unavailable" } }).as("refused");
    visitSettings({ push: "fresh" });
    cy.wait("@pushStatus");
    cy.contains(".push-card", "Background alerts").findByRole("button", { name: "Enable" }).click();
    cy.wait("@refused");
    cy.get("[role=status]").should("contain.text", "Push alerts are unavailable");
    cy.contains(".push-card", "Background alerts").findByRole("button", { name: "Enable" }).should("be.enabled");
    cy.findByLabelText(/^Failures/).should("not.exist");
  });

  it("reports an undeliverable test alert with the server's reason", () => {
    const state = fixtures();
    state.markSubscribed();
    cy.intercept("POST", "**/api/push/test", { sent: 0, failed: 0, skipped: 1, error: { code: "subscription-not-found", message: "This device is no longer registered. Disable and re-enable alerts." } }).as("testAlert");
    visitSettings({ push: "existing" });
    cy.wait("@pushStatus");
    cy.findByRole("button", { name: "Send test alert" }).click();
    cy.wait("@testAlert");
    cy.get("[role=status]").should("contain.text", "This device is no longer registered. Disable and re-enable alerts.");
  });
});

export {};
