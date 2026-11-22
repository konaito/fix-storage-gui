import { describe, expect, it } from "vitest";
import type { AccountView, SiwcStatus } from "../src/lib/api";
import { CLIENT_REVOKED_NOTICE, gateReducer, gateView, initialGate, primarySignInTarget, REAUTH_NOTICE, SIGNED_OUT_NOTICE, singleFlight, SIWC_DOCS } from "../src/lib/gate";

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
