jest.mock("request");

const request = require("request");

let AccessoryClass;

class FakeCharacteristic {
    constructor(displayName) {
        this.displayName = displayName;
        this.handlers = {};
        this.props = { format: "string" };
        this.value = null;
    }
    on(event, fn) {
        this.handlers[event] = fn;
        return this;
    }
    setProps() {}
    setValue(v) {
        this.value = v;
    }
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

require("../index.js")({
    hap: {
        Service: { AccessoryInformation: FakeInformationService, Switch: FakeSwitch },
        Characteristic: { Manufacturer: "m", Model: "mo", SerialNumber: "s" },
    },
    registerAccessory: (plugin, name, ctor) => {
        registered = { plugin, name };
        AccessoryClass = ctor;
    },
});
var registered;

// url -> response body (or Error)
let responses;

beforeEach(() => {
    responses = {};
    request.mockReset();
    request.mockImplementation((opts, cb) => {
        const r = responses[opts.url];
        if (r instanceof Error) {
            cb(r);
        } else {
            cb(null, { statusCode: 200 }, r === undefined ? "" : r);
        }
    });
});

function build(config) {
    const log = jest.fn();
    const accessory = new AccessoryClass(log, Object.assign({ service: "Switch", name: "Test" }, config));
    const [, service] = accessory.getServices();
    return { accessory, log, characteristic: service.characteristics[0] };
}

function get(characteristic) {
    return new Promise((resolve) => characteristic.handlers.get((error, value) => resolve({ error, value })));
}

function set(characteristic, value) {
    return new Promise((resolve) => characteristic.handlers.set(value, (error) => resolve({ error })));
}

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
        expect(request.mock.calls.map((c) => c[0].url)).toEqual(["http://h/a", "http://h/b"]);
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
        expect(request.mock.calls[0][0].url).toBe("http://h/set?v=on");
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
        const opts = request.mock.calls[0][0];
        expect(opts.url).toBe("http://h/set?x=a");
        expect(opts.method).toBe("POST");
        expect(opts.body).toBe("payload=1");
    });

    test("setterDelay sends only the last value", () => {
        jest.useFakeTimers();
        try {
            const { characteristic } = build({
                setterDelay: 1000,
                urls: { setOn: { url: "http://h/set?v={value}" } },
            });
            characteristic.handlers.set(0, () => {});
            characteristic.handlers.set(1, () => {});
            jest.runAllTimers();
            expect(request).toHaveBeenCalledTimes(1);
            expect(request.mock.calls[0][0].url).toBe("http://h/set?v=1");
        } finally {
            jest.useRealTimers();
        }
    });
});

describe("authentication", () => {
    const getAction = { getOn: { url: "http://h/a" } };

    function headerOf(call) {
        return request.mock.calls[call][0].headers.Authorization;
    }

    test("sends a Bearer header when bearerToken is set", async () => {
        const { characteristic } = build({ bearerToken: "tok", urls: getAction });
        await get(characteristic);
        expect(headerOf(0)).toBe("Bearer tok");
        expect(request.mock.calls[0][0].auth).toBeUndefined();
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
        expect(request).toHaveBeenCalledTimes(2);
        expect(headerOf(0)).toBe("Bearer tok");
        expect(headerOf(1)).toBe("Bearer tok");
    });

    test("fails without sending a request when the token source is unavailable", async () => {
        const { characteristic, log } = build({ bearerToken: "env:HHAA_MISSING_TOKEN", username: "u", password: "p", urls: getAction });
        const result = await get(characteristic);
        expect(result.error.message).toMatch("HHAA_MISSING_TOKEN");
        expect(request).not.toHaveBeenCalled();
        expect(log).toHaveBeenCalledWith(expect.stringContaining("HHAA_MISSING_TOKEN"));
    });
});
