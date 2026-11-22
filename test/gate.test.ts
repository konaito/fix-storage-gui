import { describe, expect, it } from "vitest";
import type { AccountView, SiwcStatus } from "../src/lib/api";
import { gateView, SIWC_DOCS } from "../src/lib/gate";

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
