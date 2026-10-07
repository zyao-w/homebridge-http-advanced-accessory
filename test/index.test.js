const fetchMock = jest.fn();

let AccessoryClass;
var registered;

class FakeCharacteristic {
    constructor(displayName) {
        this.displayName = displayName;
        this.handlers = {};
        this.props = { format: "string" };
        this.value = null;
        this.updateValue = jest.fn((v) => {
            this.value = v;
        });
    }
    on(event, fn) {
        this.handlers[event] = fn;
        return this;
    }
    setProps() {}
}

class FakeInformationService {
    setCharacteristic() {
        return this;
    }
}

class FakeSwitch {
    constructor(name) {
        this.name = name;
        this.characteristics = [new FakeCharacteristic("On")];
        this.optionalCharacteristics = [];
    }
    addCharacteristic() {}
}

class FakeMulti {
    constructor(name) {
        this.name = name;
        this.characteristics = [new FakeCharacteristic("On"), new FakeCharacteristic("Brightness")];
        this.optionalCharacteristics = [];
    }
    addCharacteristic() {}
}

const hap = {
    Service: { AccessoryInformation: FakeInformationService, Switch: FakeSwitch, Multi: FakeMulti },
    Characteristic: { Manufacturer: "m", Model: "mo", SerialNumber: "s" },
};

require("../src/index.js")({
    registerAccessory: (plugin, name, ctor) => {
        registered = { plugin, name };
        AccessoryClass = ctor;
    },
});

// url -> response body (or Error)
let responses;
const originalFetch = global.fetch;

beforeEach(() => {
    responses = {};
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url) => {
        const r = responses[url];
        if (r instanceof Error) throw r;
        return { status: 200, text: async () => (r === undefined ? "" : r) };
    });
    global.fetch = fetchMock;
});

afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
});

function build(config) {
    const log = jest.fn();
    const accessory = new AccessoryClass(log, Object.assign({ service: "Switch", name: "Test" }, config), { hap });
    const [, service] = accessory.getServices();
    return { accessory, log, characteristic: service.characteristics[0], characteristics: service.characteristics };
}

function get(characteristic) {
    return new Promise((resolve) => characteristic.handlers.get((error, value) => resolve({ error, value })));
}

function set(characteristic, value) {
    return new Promise((resolve) => characteristic.handlers.set(value, (error) => resolve({ error })));
}

const urlOf = (call) => fetchMock.mock.calls[call][0];
const initOf = (call) => fetchMock.mock.calls[call][1];

test("registers under the published package name", () => {
    expect(registered).toEqual({ plugin: "homebridge-http-advanced-accessory-zyao", name: "HttpAdvancedAccessory" });
});

describe("getter actions", () => {
    test("applies the mapper chain to the response", async () => {
        responses["http://h/status"] = "ARMED";
        const { characteristic } = build({
            urls: {
                getOn: {
                    url: "http://h/status",
                    mappers: [{ type: "static", parameters: { mapping: { ARMED: "1" } } }],
                },
            },
        });
        expect(await get(characteristic)).toEqual({ error: null, value: "1" });
    });

    test("follows the inconclusive action", async () => {
        responses["http://h/a"] = "MAYBE";
        responses["http://h/b"] = "0";
        const { characteristic } = build({
            urls: {
                getOn: {
                    url: "http://h/a",
                    mappers: [{ type: "static", parameters: { mapping: { MAYBE: "inconclusive" } } }],
                    inconclusive: { url: "http://h/b" },
                },
            },
        });
        expect(await get(characteristic)).toEqual({ error: null, value: "0" });
        expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["http://h/a", "http://h/b"]);
    });

    test("returns the error when the request fails", async () => {
        responses["http://h/a"] = new Error("ECONNREFUSED");
        const { characteristic } = build({ urls: { getOn: { url: "http://h/a" } } });
        const result = await get(characteristic);
        expect(result.error.message).toBe("ECONNREFUSED");
    });

    test("uses resultOnError when the request fails", async () => {
        responses["http://h/a"] = new Error("ECONNREFUSED");
        const { characteristic } = build({ urls: { getOn: { url: "http://h/a", resultOnError: "0" } } });
        expect(await get(characteristic)).toEqual({ error: null, value: "0" });
    });

    test("simultaneous getters on the same URL issue one request", async () => {
        responses["http://h/status"] = "5";
        const { characteristics } = build({
            service: "Multi",
            urls: {
                getOn: { url: "http://h/status" },
                getBrightness: { url: "http://h/status" },
            },
        });
        await Promise.all(characteristics.map(get));
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

describe("setter actions", () => {
    test("replaces {value} after applying mappers", async () => {
        const { characteristic } = build({
            urls: {
                setOn: {
                    url: "http://h/set?v={value}",
                    mappers: [{ type: "static", parameters: { mapping: { 1: "on" } } }],
                },
            },
        });
        const result = await set(characteristic, 1);
        expect(result.error).toBeUndefined();
        expect(urlOf(0)).toBe("http://h/set?v=on");
    });

    test("supports string templates and POST bodies", async () => {
        const { characteristic } = build({
            urls: {
                setOn: {
                    url: "http://h/set?x=${value == 1 ? 'a' : 'b'}",
                    httpMethod: "POST",
                    body: "payload={value}",
                },
            },
        });
        await set(characteristic, 1);
        expect(urlOf(0)).toBe("http://h/set?x=a");
        expect(initOf(0).method).toBe("POST");
        expect(Buffer.from(initOf(0).body).toString()).toBe("payload=1");
    });

    test("reports a failed request to HomeKit", async () => {
        responses["http://h/set?v=1"] = new Error("ECONNREFUSED");
        const { characteristic, log } = build({ urls: { setOn: { url: "http://h/set?v={value}" } } });
        const result = await set(characteristic, 1);
        expect(result.error.message).toBe("ECONNREFUSED");
        expect(log).toHaveBeenCalledWith("SetState function failed: %s", "ECONNREFUSED");
    });

    test("setterDelay sends only the last value", async () => {
        jest.useFakeTimers();
        const { characteristic } = build({
            setterDelay: 1000,
            urls: { setOn: { url: "http://h/set?v={value}" } },
        });
        characteristic.handlers.set(0, () => {});
        characteristic.handlers.set(1, () => {});
        await jest.advanceTimersByTimeAsync(1000);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(urlOf(0)).toBe("http://h/set?v=1");
    });
});

describe("polling (forceRefreshDelay)", () => {
    test("actions on the same URL share one request per interval", async () => {
        jest.useFakeTimers();
        responses["http://h/status"] = "7";
        const { characteristics } = build({
            service: "Multi",
            forceRefreshDelay: 5,
            urls: {
                getOn: { url: "http://h/status" },
                getBrightness: { url: "http://h/status", mappers: [{ type: "static", parameters: { mapping: { 7: "70" } } }] },
            },
        });
        const [on, brightness] = characteristics;

        on.handlers.get(() => {});
        brightness.handlers.get(() => {});
        await jest.advanceTimersByTimeAsync(0);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(on.updateValue).toHaveBeenLastCalledWith("7");
        expect(brightness.updateValue).toHaveBeenLastCalledWith("70");

        await jest.advanceTimersByTimeAsync(5000);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    test("returns the cached value immediately", async () => {
        jest.useFakeTimers();
        const { characteristic } = build({ forceRefreshDelay: 5, urls: { getOn: { url: "http://h/status" } } });
        characteristic.value = "cached";
        const result = await new Promise((resolve) => characteristic.handlers.get((e, v) => resolve(v)));
        expect(result).toBe("cached");
    });

    test("a getter without an action does not poll", async () => {
        jest.useFakeTimers();
        const { characteristic } = build({ forceRefreshDelay: 5, urls: {} });
        characteristic.handlers.get(() => {});
        await jest.advanceTimersByTimeAsync(10000);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(characteristic.updateValue).not.toHaveBeenCalled();
    });

    test("keeps polling after a failed request", async () => {
        jest.useFakeTimers();
        responses["http://h/status"] = new Error("down");
        const { characteristic, log } = build({ forceRefreshDelay: 5, urls: { getOn: { url: "http://h/status" } } });
        characteristic.handlers.get(() => {});
        await jest.advanceTimersByTimeAsync(0);
        expect(log).toHaveBeenCalledWith("Poller errored: %s", "down");

        responses["http://h/status"] = "1";
        await jest.advanceTimersByTimeAsync(5000);
        expect(characteristic.updateValue).toHaveBeenLastCalledWith("1");
    });

    test("continues polling when a response is inconclusive and has no fallback", async () => {
        jest.useFakeTimers();
        responses["http://h/status"] = "MAYBE";
        const { characteristic } = build({
            forceRefreshDelay: 5,
            urls: {
                getOn: { url: "http://h/status", mappers: [{ type: "static", parameters: { mapping: { MAYBE: "inconclusive" } } }] },
            },
        });
        characteristic.handlers.get(() => {});
        await jest.advanceTimersByTimeAsync(0);
        responses["http://h/status"] = "1";
        await jest.advanceTimersByTimeAsync(5000);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});

describe("robustness", () => {
    test("reports an unknown service", () => {
        expect(() => build({ service: "Nope" })).toThrow('Unknown service "Nope"');
    });

    test("reports an unknown mapper type but keeps working", async () => {
        responses["http://h/a"] = "5";
        const { characteristic, log } = build({
            urls: { getOn: { url: "http://h/a", mappers: [{ type: "nope", parameters: {} }] } },
        });
        expect(log).toHaveBeenCalledWith('WARNING: Unknown mapper type "nope" ignored');
        expect(await get(characteristic)).toEqual({ error: null, value: "5" });
    });

    test("fails the getter when the response is inconclusive and there is no fallback", async () => {
        responses["http://h/a"] = "MAYBE";
        const { characteristic } = build({
            urls: { getOn: { url: "http://h/a", mappers: [{ type: "static", parameters: { mapping: { MAYBE: "inconclusive" } } }] } },
        });
        const result = await get(characteristic);
        expect(result.error.message).toMatch("Inconclusive");
    });

    test("reports a broken template to HomeKit without sending a request", async () => {
        const { characteristic } = build({ urls: { setOn: { url: "http://h/${missing.prop}" } } });
        const result = await set(characteristic, 1);
        expect(result.error).toBeInstanceOf(ReferenceError);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test("a delayed setter without a set action does nothing", async () => {
        jest.useFakeTimers();
        const { characteristic } = build({ setterDelay: 100, urls: {} });
        characteristic.handlers.set(1, () => {});
        await jest.advanceTimersByTimeAsync(100);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test("debug logging never contains the bearer token or password", async () => {
        responses["http://h/a"] = "1";
        const { characteristic, log } = build({
            debug: true,
            bearerToken: "super-secret-token",
            password: "super-secret-password",
            urls: { getOn: { url: "http://h/a" }, setOn: { url: "http://h/set?v={value}" } },
        });
        await get(characteristic);
        await set(characteristic, 1);
        const output = JSON.stringify(log.mock.calls);
        expect(output).not.toMatch(/super-secret/);
    });

    test("announces the 2.0.0 Platform change once per process", () => {
        jest.isolateModules(() => {
            const Fresh = require("../src/accessory.js");
            const log = jest.fn();
            new Fresh(log, { name: "A", service: "Switch" }, { hap });
            new Fresh(log, { name: "B", service: "Switch" }, { hap });
            const notices = log.mock.calls.filter(([m]) => /NOTICE.*Dynamic Platform/.test(m));
            expect(notices).toHaveLength(1);
        });
    });
});

describe("authentication", () => {
    const getAction = { getOn: { url: "http://h/a" } };

    function headerOf(call) {
        return initOf(call).headers.Authorization;
    }

    test("sends a Bearer header when bearerToken is set", async () => {
        const { characteristic } = build({ bearerToken: "tok", urls: getAction });
        await get(characteristic);
        expect(headerOf(0)).toBe("Bearer tok");
    });

    test("bearerToken takes precedence over username/password", async () => {
        const { characteristic } = build({ bearerToken: "tok", username: "u", password: "p", urls: getAction });
        await get(characteristic);
        expect(headerOf(0)).toBe("Bearer tok");
    });

    test("falls back to Basic auth without bearerToken", async () => {
        const { characteristic } = build({ username: "u", password: "p", urls: getAction });
        await get(characteristic);
        expect(headerOf(0)).toBe("Basic " + Buffer.from("u:p").toString("base64"));
    });

    test("sends no Authorization header without credentials", async () => {
        const { characteristic } = build({ urls: getAction });
        await get(characteristic);
        expect(headerOf(0)).toBeUndefined();
    });

    test("trims the token", async () => {
        const { characteristic } = build({ bearerToken: "  tok\n", urls: getAction });
        await get(characteristic);
        expect(headerOf(0)).toBe("Bearer tok");
    });

    test("reads the token from an environment variable", async () => {
        process.env.HHAA_INDEX_TOKEN = "env-token";
        try {
            const { characteristic } = build({ bearerToken: "env:HHAA_INDEX_TOKEN", urls: getAction });
            await get(characteristic);
            expect(headerOf(0)).toBe("Bearer env-token");
        } finally {
            delete process.env.HHAA_INDEX_TOKEN;
        }
    });

    test("the inconclusive sub action also carries the token", async () => {
        responses["http://h/a"] = "MAYBE";
        responses["http://h/b"] = "1";
        const { characteristic } = build({
            bearerToken: "tok",
            urls: {
                getOn: {
                    url: "http://h/a",
                    mappers: [{ type: "static", parameters: { mapping: { MAYBE: "inconclusive" } } }],
                    inconclusive: { url: "http://h/b" },
                },
            },
        });
        await get(characteristic);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(headerOf(0)).toBe("Bearer tok");
        expect(headerOf(1)).toBe("Bearer tok");
    });

    test("fails without sending a request when the token source is unavailable", async () => {
        const { characteristic, log } = build({ bearerToken: "env:HHAA_MISSING_TOKEN", username: "u", password: "p", urls: getAction });
        const result = await get(characteristic);
        expect(result.error.message).toMatch("HHAA_MISSING_TOKEN");
        expect(fetchMock).not.toHaveBeenCalled();
        expect(log).toHaveBeenCalledWith(expect.stringContaining("HHAA_MISSING_TOKEN"));
    });
});
