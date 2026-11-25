import { describe, expect, it } from "vitest";
import { readAuthStatus } from "../client/src/authStatus";

describe("login status response compatibility", () => {
  it("keeps the login page visible for a successful anonymous status response", async () => {
    expect(await readAuthStatus(new Response(JSON.stringify({ ok: true, authenticated: false, signedIn: false, passwordSet: false })))).toEqual({ authenticated: false, signedIn: false, passwordSet: false });
    expect(await readAuthStatus(new Response(JSON.stringify({ ok: true, authenticated: true, signedIn: true })))).toEqual({ authenticated: true, signedIn: true, passwordSet: true });
  });

  it("understands the old 401 status and earlier authenticated responses", async () => {
    expect(await readAuthStatus(new Response('{"username":"Ada"}', { status: 401 }))).toEqual({ authenticated: false, signedIn: false, passwordSet: true });
    expect(await readAuthStatus(new Response('{"ok":true}'))).toEqual({ authenticated: true, signedIn: false, passwordSet: true });
    expect(await readAuthStatus(new Response(null, { status: 404 }))).toEqual({ authenticated: true, signedIn: false, passwordSet: true });
  });

  it("keeps an error or malformed response out of the authenticated app", async () => {
    expect((await readAuthStatus(new Response('{"authenticated":true}', { status: 500 }))).authenticated).toBe(false);
    expect((await readAuthStatus(new Response('invalid'))).authenticated).toBe(false);
    expect((await readAuthStatus(new Response('{}'))).authenticated).toBe(false);
  });
});
