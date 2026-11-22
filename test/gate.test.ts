import { describe, expect, it } from "vitest";
import type { AccountView, SiwcStatus } from "../src/lib/api";
import {
  CLIENT_REVOKED_NOTICE,
  gateReducer,
  gateScreen,
  gateView,
  initialGate,
  primarySignInTarget,
  REAUTH_NOTICE,
  SIGNED_OUT_NOTICE,
  singleFlight,
  SIWC_DOCS,
  type GateAction,
  type GateModel,
} from "../src/lib/gate";

const acc = (o: Partial<AccountView> = {}): AccountView => ({
  clientId: "oaiapp_1",
  label: "a@example.com (…app_1)",
  email: "a@example.com",
  planEnabled: true,
  signedIn: true,
  needsReauth: false,
  ...o,
});
const st = (accounts: AccountView[], active: string | null = "oaiapp_1"): SiwcStatus => ({ hostId: "urn:uuid:x", active, accounts, showWelcome: false });

describe("login gate", () => {
  it("waits while the Keychain is checked", () => {
    expect(gateView(null, null).kind).toBe("checking");
  });
  it("shows a retryable error when status cannot be read", () => {
    expect(gateView(null, "boom")).toEqual({ kind: "load_error", message: "boom" });
  });
  it("requires sign-in with no accounts or no active account", () => {
    expect(gateView(st([], null), null)).toEqual({ kind: "signed_out", reauth: null });
    expect(gateView(st([acc()], null), null)).toEqual({ kind: "signed_out", reauth: null });
  });
  it("requires sign-in when tokens are gone, remembering a reauth account", () => {
    const a = acc({ signedIn: false, needsReauth: true });
    expect(gateView(st([a]), null)).toEqual({ kind: "signed_out", reauth: a });
    expect(gateView(st([acc({ signedIn: false })]), null)).toEqual({ kind: "signed_out", reauth: null });
  });
  it("blocks accounts without ChatGPT plan usage", () => {
    expect(gateView(st([acc({ planEnabled: false })]), null).kind).toBe("plan_disabled");
  });
  it("lets a signed-in account with plan usage through", () => {
    expect(gateView(st([acc()]), null).kind).toBe("ready");
  });
  it("links only official Sign in with ChatGPT docs over https", () => {
    for (const d of SIWC_DOCS) expect(d.url).toMatch(/^https:\/\/developers\.openai\.com\/siwc(\/|$)/);
  });
});

describe("rule-only choice", () => {
  it("is remembered per account and cleared on sign-out", async () => {
    const mem = new Map<string, string>();
    const ls = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
      key: (i: number) => [...mem.keys()][i] ?? null,
      get length() {
        return mem.size;
      },
    };
    const g = globalThis as unknown as { localStorage?: unknown };
    g.localStorage = ls;
    const { ruleOnlyChoice } = await import("../src/lib/gate");
    expect(ruleOnlyChoice.get("oaiapp_1")).toBe(false);
    ruleOnlyChoice.set("oaiapp_1", true);
    expect(ruleOnlyChoice.get("oaiapp_1")).toBe(true);
    expect(ruleOnlyChoice.get("oaiapp_2")).toBe(false);
    mem.set("other", "x");
    ruleOnlyChoice.clearAll();
    expect(ruleOnlyChoice.get("oaiapp_1")).toBe(false);
    expect(mem.has("other")).toBe(true);
    delete g.localStorage;
  });
  it("falls back to not remembered when storage is unavailable", async () => {
    const { ruleOnlyChoice } = await import("../src/lib/gate");
    expect(ruleOnlyChoice.get("oaiapp_1")).toBe(false);
  });
});

describe("main sign-in button target", () => {
  it("reauthorises the only saved registration after a sign-out instead of registering a new client", () => {
    const saved = acc({ signedIn: false });
    expect(primarySignInTarget(null, [saved])?.clientId).toBe("oaiapp_1");
  });
  it("prefers the registration that needs reauth", () => {
    const a = acc({ signedIn: false });
    const b = acc({ clientId: "oaiapp_2", signedIn: false, needsReauth: true });
    expect(primarySignInTarget(b, [a, b])?.clientId).toBe("oaiapp_2");
  });
  it("registers a new client when there is nothing saved or the choice is ambiguous", () => {
    expect(primarySignInTarget(null, [])).toBeNull();
    expect(primarySignInTarget(null, [acc(), acc({ clientId: "oaiapp_2" })])).toBeNull();
  });
});

describe("gate state (#29, #30)", () => {
  const ready = gateReducer(initialGate, { type: "loaded", status: st([acc()]) });

  it("goes back to the login screen when a token stops working during use", () => {
    expect(gateView(ready.status, ready.loadError).kind).toBe("ready");
    // Rust: refresh refused -> mark_reauth -> siwc-changed "reauth"; the gate then reads status again.
    let s = gateReducer(ready, { type: "changed", event: { reason: "reauth", remoteRevoked: null } });
    expect(s.statusVersion).toBe(1);
    expect(s.notice).toBe(REAUTH_NOTICE);
    s = gateReducer(s, { type: "loaded", status: st([acc({ signedIn: false, needsReauth: true })]) });
    const v = gateView(s.status, s.loadError);
    expect(v.kind).toBe("signed_out");
    expect(v.kind === "signed_out" && v.reauth?.clientId).toBe("oaiapp_1");
  });

  it("asks for a new sign-in when the registration is gone (invalid_client)", () => {
    // Rust removes the registration, clears the active account and sends "client_revoked".
    let s = gateReducer(ready, { type: "changed", event: { reason: "client_revoked", remoteRevoked: null } });
    expect(s.notice).toBe(CLIENT_REVOKED_NOTICE);
    s = gateReducer(s, { type: "loaded", status: st([], null) });
    expect(gateView(s.status, s.loadError)).toEqual({ kind: "signed_out", reauth: null });
    expect(primarySignInTarget(null, s.status?.accounts ?? [])).toBeNull();
    // Someone else's registration is still saved: the main button points at it, so the notice
    // (still shown) tells how to register anew.
    const other = acc({ clientId: "oaiapp_2", signedIn: false });
    s = gateReducer(s, { type: "loaded", status: st([other], null) });
    expect(primarySignInTarget(null, s.status?.accounts ?? [])?.clientId).toBe("oaiapp_2");
    expect(s.notice).toBe(CLIENT_REVOKED_NOTICE);
  });

  it("does not replace the sign-out notice with the reauth one", () => {
    let s = gateReducer(ready, { type: "changed", event: { reason: "signed_out", remoteRevoked: true } });
    s = gateReducer(s, { type: "changed", event: { reason: "reauth", remoteRevoked: null } });
    expect(s.notice).toBe(SIGNED_OUT_NOTICE);
  });

  it("keeps one signingIn flag that clears on success, failure or cancel", () => {
    let s = gateReducer(ready, { type: "signInStart" });
    expect(s.signingIn).toBe(true);
    s = gateReducer(s, { type: "signInEnd" });
    s = gateReducer(s, { type: "error", error: { message: "x", cancelled: true } });
    expect(s.signingIn).toBe(false);
    expect(s.error?.cancelled).toBe(true);
  });
});

describe("one sign-in at a time (#30)", () => {
  it("does not start a second sign-in while one is running, and allows one after it ends", async () => {
    let finish: (v: string) => void = () => {};
    let calls = 0;
    const run = singleFlight(
      () =>
        new Promise<string>((resolve) => {
          calls++;
          finish = resolve;
        }),
    );
    const first = run();
    expect(await run()).toEqual({ started: false });
    finish("a");
    expect(await first).toEqual({ started: true, value: "a" });
    const third = run();
    expect(calls).toBe(2);
    finish("b");
    await third;
  });
  it("is released when the sign-in fails", async () => {
    const run = singleFlight(async () => {
      throw new Error("cancelled");
    });
    await expect(run()).rejects.toThrow("cancelled");
    await expect(run()).rejects.toThrow("cancelled");
  });
});

describe("keeping scan results when a token stops working (#75)", () => {
  const run = (actions: GateAction[], from: GateModel = initialGate) => actions.reduce(gateReducer, from);
  const never = () => false;
  const ready = run([{ type: "loaded", status: st([acc()]) }]);
  const withResults = run([{ type: "app", hasResults: true, busy: null }], ready);
  const reauthed = (from: GateModel) =>
    run([{ type: "changed", event: { reason: "reauth", remoteRevoked: null } }, { type: "loaded", status: st([acc({ signedIn: false, needsReauth: true })]) }], from);
  const revoked = (from: GateModel, rest: AccountView[] = []) =>
    run([{ type: "changed", event: { reason: "client_revoked", remoteRevoked: null } }, { type: "loaded", status: st(rest, null) }], from);

  it("keeps the app mounted with a sign-in-again bar after reauth when there are results", () => {
    const s = reauthed(withResults);
    const v = gateScreen(s, never);
    expect(v).toMatchObject({ kind: "app", planEnabled: false, bar: { kind: "reauth", reason: "reauth", target: "oaiapp_1" } });
    // The bar says it; the login-screen notice ("ログイン画面に戻りました") would be wrong here.
    expect(s.notice).toBeNull();
  });

  it("keeps the app after client_revoked and signs in with a new registration, not someone else's", () => {
    const other = acc({ clientId: "oaiapp_2", signedIn: false });
    const v = gateScreen(revoked(withResults, [other]), never);
    expect(v).toMatchObject({ kind: "app", bar: { kind: "reauth", reason: "client_revoked", target: null } });
  });

  it("keeps the app while a scan or AI run is still going", () => {
    const busy = run([{ type: "app", hasResults: true, busy: "AI 判定中" }], ready);
    const s = reauthed(busy);
    expect(gateScreen(s, never).kind).toBe("app");
    expect(s.appBusy).toBe("AI 判定中");
  });

  it("shows the login screen as before when there is nothing to keep", () => {
    const s = reauthed(ready);
    expect(gateScreen(s, never)).toMatchObject({ kind: "login", view: { kind: "signed_out" } });
    expect(s.notice).toBe(REAUTH_NOTICE);
    expect(gateScreen(revoked(ready), never).kind).toBe("login");
    // Already needing reauth at launch: the app never had results.
    const atLaunch = run([{ type: "loaded", status: st([acc({ signedIn: false, needsReauth: true })]) }]);
    expect(gateScreen(atLaunch, never).kind).toBe("login");
  });

  it("goes to the login screen on an explicit sign-out", () => {
    const s = run([{ type: "changed", event: { reason: "signed_out", remoteRevoked: true } }, { type: "loaded", status: st([acc({ signedIn: false })]) }], reauthed(withResults));
    expect(gateScreen(s, never).kind).toBe("login");
    expect(s.notice).toBe(SIGNED_OUT_NOTICE);
  });

  it("goes to the login screen, with the reauth notice, when the app drops its results", () => {
    const s = run([{ type: "app", hasResults: false, busy: null }], reauthed(withResults));
    expect(gateScreen(s, never).kind).toBe("login");
    expect(s.notice).toBe(REAUTH_NOTICE);
  });

  it("drops the bar once signed in again, and a later reauth with no results goes to the login screen", () => {
    let s = run([{ type: "loaded", status: st([acc()]) }], reauthed(withResults));
    expect(gateScreen(s, never)).toMatchObject({ kind: "app", planEnabled: true, bar: null });
    expect(s.keepApp).toBeNull();
    s = reauthed(run([{ type: "app", hasResults: false, busy: null }], s));
    expect(gateScreen(s, never).kind).toBe("login");
  });

  it("keeps the app in rule-only mode when the new sign-in did not allow plan usage", () => {
    const s = run([{ type: "loaded", status: st([acc({ planEnabled: false })]) }], reauthed(withResults));
    expect(gateScreen(s, never)).toMatchObject({ kind: "app", planEnabled: false, bar: { kind: "rule_only" } });
  });

  it("keeps the app when the app's own status read lands before the siwc-changed event", () => {
    // App.handleAiError tells the gate first, then reads status; the event may arrive later or not at all.
    const s = run([{ type: "lost", reason: "reauth" }, { type: "loaded", status: st([acc({ signedIn: false, needsReauth: true })]) }], withResults);
    expect(gateScreen(s, never)).toMatchObject({ kind: "app", bar: { kind: "reauth", reason: "reauth" } });
    const later = run([{ type: "changed", event: { reason: "reauth", remoteRevoked: null } }], s);
    expect(gateScreen(later, never)).toMatchObject({ kind: "app", bar: { kind: "reauth" } });
    // Without results (e.g. the model list failed before any scan) it stays the login screen.
    const none = run([{ type: "lost", reason: "reauth" }, { type: "loaded", status: st([acc({ signedIn: false, needsReauth: true })]) }], ready);
    expect(gateScreen(none, never).kind).toBe("login");
  });

  it("keeps the app when reading status fails while the bar is up", () => {
    const s = run([{ type: "loadFailed", message: "keychain busy" }], reauthed(withResults));
    expect(gateScreen(s, never)).toMatchObject({ kind: "app", bar: { kind: "reauth" } });
  });
});
