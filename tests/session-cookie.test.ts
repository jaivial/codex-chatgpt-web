import { describe, expect, test } from "bun:test";
import { parseSessionCookieInput } from "../src/browser-login";

describe("parseSessionCookieInput", () => {
  test("raw session token -> chatgpt.com cookie", () => {
    const state = parseSessionCookieInput("eyJhbGciOiJ.abc.def") as { cookies: Array<Record<string, unknown>>; origins: unknown[] };
    expect(state.cookies).toHaveLength(1);
    expect(state.cookies[0].name).toBe("__Secure-next-auth.session-token");
    expect(state.cookies[0].domain).toBe(".chatgpt.com");
    expect(state.cookies[0].httpOnly).toBe(true);
    expect(state.origins).toEqual([]);
  });

  test("cookie header -> multiple cookies", () => {
    const state = parseSessionCookieInput("cf_clearance=xyz; __Secure-next-auth.session-token=tok") as unknown as { cookies: Array<Record<string, string>> };
    expect(state.cookies.map(c => c.name)).toEqual(["cf_clearance", "__Secure-next-auth.session-token"]);
  });

  test("storageState JSON passes through", () => {
    const state = parseSessionCookieInput('{"cookies":[{"name":"a","value":"b"}],"origins":[]}') as { cookies: unknown[] };
    expect(state.cookies).toHaveLength(1);
  });

  test("rejects empty input", () => {
    expect(() => parseSessionCookieInput("")).toThrow();
    expect(() => parseSessionCookieInput("{}")).toThrow();
  });
});
