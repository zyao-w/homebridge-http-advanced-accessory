const { parseConfig } = require("../src/config.js");

test("applies defaults", () => {
    const c = parseConfig({ name: "A", service: "Switch" });
    expect(c).toMatchObject({
        name: "A",
        service: "Switch",
        optionCharacteristic: [],
        props: {},
        forceRefreshDelay: 0,
        setterDelay: 0,
        urls: {},
        authError: null,
        auth: { username: "", password: "", bearerToken: "", immediately: true },
    });
});

test("cacheTTL defaults to forceRefreshDelay and can be overridden", () => {
    expect(parseConfig({ forceRefreshDelay: 5 }).http.cacheTTL).toBe(5);
    expect(parseConfig({ forceRefreshDelay: 5, cacheTTL: 0 }).http.cacheTTL).toBe(0);
    expect(parseConfig({}).http.cacheTTL).toBe(0);
});

test("passes request settings through", () => {
    const { http } = parseConfig({ timeout: 2000, retries: 2, maxConcurrent: 1, uriCallsDelay: 50 });
    expect(http).toMatchObject({ timeout: 2000, retries: 2, maxConcurrent: 1, uriCallsDelay: 50 });
});

test("resolves and trims the bearer token", () => {
    expect(parseConfig({ bearerToken: " tok\n" }).auth.bearerToken).toBe("tok");
});

test("reports an unavailable token source instead of throwing", () => {
    const c = parseConfig({ bearerToken: "env:HHAA_CONFIG_MISSING" });
    expect(c.auth.bearerToken).toBe("");
    expect(c.authError.message).toMatch("HHAA_CONFIG_MISSING");
});

test("honours immediately: false", () => {
    expect(parseConfig({ immediately: false }).auth.immediately).toBe(false);
});
