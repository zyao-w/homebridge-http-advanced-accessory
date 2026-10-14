const fs = require("fs");
const os = require("os");
const path = require("path");
const handlers = require("../src/ui-handlers.js");
const legacy = require("./fixtures/config-1x.json");

const platform = (devices, extra = {}) => [
	{ platform: "HttpAdvancedPlatform", name: "HTTP Advanced", devices, ...extra },
];

const sensor = (extra = {}) => ({
	name: "Air",
	service: "CarbonDioxideSensor",
	characteristics: [
		{
			characteristic: "CarbonDioxideLevel",
			get: {
				url: "http://air.local/api",
				mappers: [{ type: "jpath", jpath: "$.data.co2" }, { type: "number" }],
			},
		},
	],
	...extra,
});

/** A fetch that answers with a fixed response and remembers what it was asked. */
function fakeFetch(body, status = 200) {
	const calls = [];
	const fetch = async (url, init) => {
		calls.push({ url, init });
		return { status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
	};
	fetch.calls = calls;
	return fetch;
}

describe("validate", () => {
	test("reports nothing for a valid configuration", () => {
		const result = handlers.validate({ config: platform([sensor()]) });
		expect(result.platform).toEqual([]);
		expect(result.devices).toEqual([{ index: 0, name: "Air", errors: [], warnings: [], characteristics: 1 }]);
	});

	test("has nothing to report while the plugin is not configured", () => {
		expect(handlers.validate({ config: [] })).toEqual({ platform: [], devices: [] });
		expect(handlers.validate({})).toEqual({ platform: [], devices: [] });
	});

	test("explains what is wrong with a device, in the words of the log", () => {
		const result = handlers.validate({
			config: platform([{ name: "Broken", timeout: "soon" }, sensor({ service: "" })]),
		});
		expect(result.devices[0].errors.join()).toMatch(/timeout/);
		expect(result.devices[1].errors.join()).toMatch(/no "service"/);
	});

	test("uses the defaults of the platform, as the platform does", () => {
		const device = sensor({ characteristics: [{ characteristic: "On", set: { url: "http://x/${state.a + 1}" } }] });
		const without = handlers.validate({ config: platform([device]) });
		expect(without.devices[0].errors).toEqual([]);

		const script = sensor({
			characteristics: [{ characteristic: "On", get: { url: "http://x", mappers: [{ type: "script", script: "1" }] } }],
		});
		expect(handlers.validate({ config: platform([script]) }).devices[0].errors.join()).toMatch(/allowUnsafeEval/);
		expect(
			handlers.validate({ config: platform([script], { defaults: { allowUnsafeEval: true } }) }).devices[0].errors
		).toEqual([]);
	});

	test("reports two devices with the same identifier", () => {
		const result = handlers.validate({ config: platform([sensor(), sensor({ service: "HumiditySensor" })]) });
		expect(result.devices[0].errors).toEqual([]);
		expect(result.devices[1].errors.join()).toMatch(/same identifier as "Air"/);

		const withIds = handlers.validate({ config: platform([sensor({ id: "a" }), sensor({ id: "b" })]) });
		expect(withIds.devices.map((device) => device.errors)).toEqual([[], []]);
	});

	test("reports a problem with the platform settings and a device that is not an object", () => {
		const result = handlers.validate({ config: platform([null, sensor()], { colour: "red" }) });
		expect(result.platform.join()).toMatch(/colour/);
		expect(result.devices[0].errors).toEqual(["is not an object"]);
	});

	test("warns about a token that cannot be read, without showing it", () => {
		const result = handlers.validate({ config: platform([sensor({ bearerToken: "env:HTTP_ADVANCED_TEST_UNSET" })]) });
		expect(result.devices[0].warnings.join()).toMatch(/HTTP_ADVANCED_TEST_UNSET/);
	});

	test("accepts a single platform block as well as a list", () => {
		expect(handlers.validate({ config: platform([sensor()])[0] }).devices).toHaveLength(1);
	});
});

describe("testGet", () => {
	const air = { data: { co2: "812.4", temperature: 21.5 } };

	test("shows the status, the response and the result of every mapper", async () => {
		const fetch = fakeFetch(air);
		const result = await handlers.createTestGet({ fetch })({ device: sensor(), characteristic: "CarbonDioxideLevel" });

		expect(result).toMatchObject({ ok: true, status: 200, value: "812.4", valueType: "number", format: "json" });
		expect(result.steps).toEqual([
			{ type: "jpath", input: JSON.stringify(air), output: "812.4" },
			{ type: "number", input: "812.4", output: "812.4" },
		]);
		expect(result.body).toBe(JSON.stringify(air));
		expect(result.suggestions).toEqual([
			{ type: "jpath", path: "$.data.co2", sample: "812.4" },
			{ type: "jpath", path: "$.data.temperature", sample: "21.5" },
		]);
		expect(fetch.calls).toHaveLength(1);
	});

	test("sends the request the way the plugin does: method, body, authentication and headers", async () => {
		const fetch = fakeFetch(air);
		const device = sensor({
			bearerToken: "secret-token",
			headers: [{ name: "X-Api-Key", value: "key-1" }],
		});
		device.characteristics[0].get.httpMethod = "POST";
		device.characteristics[0].get.body = '{"q":1}';
		await handlers.createTestGet({ fetch })({ device, characteristic: "CarbonDioxideLevel" });

		const { url, init } = fetch.calls[0];
		expect(url).toBe("http://air.local/api");
		expect(init.method).toBe("POST");
		expect(init.headers).toMatchObject({ Authorization: "Bearer secret-token", "X-Api-Key": "key-1" });
		expect(String(init.body)).toBe('{"q":1}');
	});

	test("uses the defaults of the platform", async () => {
		const fetch = fakeFetch(air);
		await handlers.createTestGet({ fetch })({
			device: sensor(),
			defaults: { bearerToken: "from-defaults" },
			characteristic: "CarbonDioxideLevel",
		});
		expect(fetch.calls[0].init.headers.Authorization).toBe("Bearer from-defaults");
	});

	test("never returns a credential", async () => {
		const device = sensor({ bearerToken: "secret-token", password: "hunter2" });
		const result = await handlers.createTestGet({ fetch: fakeFetch(air) })({
			device,
			characteristic: "CarbonDioxideLevel",
		});
		expect(JSON.stringify(result)).not.toMatch(/secret-token|hunter2/);
	});

	test("reports an HTTP error with its status, and does not map the body", async () => {
		const result = await handlers.createTestGet({ fetch: fakeFetch("nope", 401) })({
			device: sensor(),
			characteristic: "CarbonDioxideLevel",
		});
		expect(result).toMatchObject({ ok: false, status: 401, error: "HTTP 401 Unauthorized", steps: [] });
	});

	test("reports a network error without the URL", async () => {
		const fetch = async () => {
			throw new Error("connect ECONNREFUSED");
		};
		const result = await handlers.createTestGet({ fetch })({ device: sensor(), characteristic: "CarbonDioxideLevel" });
		expect(result).toMatchObject({ ok: false, error: "connect ECONNREFUSED" });
		expect(JSON.stringify(result)).not.toContain("air.local");
	});

	test("follows the fallback of an inconclusive result", async () => {
		const device = sensor();
		device.characteristics[0].get = {
			url: "http://air.local/primary",
			mappers: [{ type: "number" }],
			inconclusive: { url: "http://air.local/backup", mappers: [{ type: "jpath", jpath: "$.v" }, { type: "number" }] },
		};
		const fetch = async (url) => ({
			status: 200,
			text: async () => (url.endsWith("primary") ? "offline" : '{"v": 7}'),
		});
		const result = await handlers.createTestGet({ fetch })({ device, characteristic: "CarbonDioxideLevel" });

		expect(result).toMatchObject({ ok: true, inconclusive: true, value: "7" });
		expect(result.fallback).toMatchObject({ ok: true, value: "7" });
	});

	test("fails when the result is inconclusive and there is no fallback", async () => {
		const result = await handlers.createTestGet({ fetch: fakeFetch("offline") })({
			device: sensor(),
			characteristic: "CarbonDioxideLevel",
		});
		expect(result).toMatchObject({
			ok: false,
			inconclusive: true,
			error: "Inconclusive response and no fallback action",
		});
	});

	test("shows resultOnError when the request fails", async () => {
		const device = sensor();
		device.characteristics[0].get.resultOnError = "0";
		const result = await handlers.createTestGet({ fetch: fakeFetch("x", 503) })({
			device,
			characteristic: "CarbonDioxideLevel",
		});
		expect(result).toMatchObject({
			ok: true,
			usedResultOnError: true,
			value: "0",
			error: "HTTP 503 Service Unavailable",
		});
	});

	test("reads a characteristic of an additional service", async () => {
		const device = sensor({
			additionalServices: [
				{
					id: "temp",
					service: "TemperatureSensor",
					characteristics: [
						{
							characteristic: "CurrentTemperature",
							get: { url: "http://air.local/api", mappers: [{ type: "jpath", jpath: "$.data.temperature" }] },
						},
					],
				},
			],
		});
		const result = await handlers.createTestGet({ fetch: fakeFetch(air) })({
			device,
			service: "temp",
			characteristic: "CurrentTemperature",
		});
		expect(result).toMatchObject({ ok: true, value: "21.5" });
	});

	test("is off when the Homebridge UI has no login, and sends nothing", async () => {
		const fetch = fakeFetch(air);
		const payload = { device: sensor(), characteristic: "CarbonDioxideLevel" };

		expect(await handlers.createTestGet({ fetch, authDisabled: true })(payload)).toMatchObject({
			ok: false,
			disabled: true,
		});
		expect(await handlers.createTestGet({ fetch })({ ...payload, uiAuth: "none" })).toMatchObject({ disabled: true });
		expect(fetch.calls).toHaveLength(0);
	});

	test("only sends http and https requests", async () => {
		const fetch = fakeFetch(air);
		const device = sensor();
		device.characteristics[0].get.url = "file:///etc/passwd";
		const result = await handlers.createTestGet({ fetch })({ device, characteristic: "CarbonDioxideLevel" });
		expect(result).toMatchObject({ ok: false, error: "Only http and https URLs can be tested" });
		expect(fetch.calls).toHaveLength(0);
	});

	test("explains a device or a characteristic that cannot be tested", async () => {
		const testGet = handlers.createTestGet({ fetch: fakeFetch(air) });
		expect((await testGet({})).error).toMatch(/no device/);
		expect((await testGet({ device: sensor({ service: "" }), characteristic: "X" })).error).toMatch(/service/);
		expect((await testGet({ device: sensor(), characteristic: "Missing" })).error).toMatch(/no get action/);
	});

	test("cuts a long response", async () => {
		const result = await handlers.createTestGet({ fetch: fakeFetch("x".repeat(10000)) })({
			device: sensor({ characteristics: [{ characteristic: "On", get: { url: "http://x" } }] }),
			characteristic: "On",
		});
		expect(result.body).toHaveLength(4000);
		expect(result.truncated).toBe(true);
	});
});

describe("previewSet", () => {
	const lamp = (extra = {}) => ({
		name: "Lamp",
		service: "Switch",
		characteristics: [
			{
				characteristic: "On",
				set: {
					url: "http://lamp.local/power?state={value}",
					mappers: [
						{
							type: "static",
							mapping: [
								{ from: "true", to: "on" },
								{ from: "false", to: "off" },
							],
						},
					],
				},
			},
		],
		...extra,
	});

	test("shows what would be sent, after the mappers", () => {
		expect(handlers.previewSet({ device: lamp(), characteristic: "On", value: "true" })).toEqual({
			ok: true,
			method: "GET",
			url: "http://lamp.local/power?state=on",
			body: "",
			value: "true",
			mappedValue: "on",
		});
	});

	test("renders the body and the expressions of the templates", () => {
		const device = lamp();
		device.characteristics[0].set = {
			url: "http://lamp.local/level",
			httpMethod: "POST",
			body: '{"level": ${value * 2}}',
		};
		const result = handlers.previewSet({ device, characteristic: "On", value: "21" });
		expect(result).toMatchObject({ ok: true, method: "POST", body: '{"level": 42}' });
	});

	test("explains a value that the mappers cannot convert", () => {
		const device = lamp();
		device.characteristics[0].set.mappers = [{ type: "number" }];
		expect(handlers.previewSet({ device, characteristic: "On", value: "abc" }).error).toMatch(/could not convert/);
	});

	test("explains a characteristic without a set action", () => {
		expect(handlers.previewSet({ device: lamp(), characteristic: "Brightness", value: "1" }).error).toMatch(
			/no set action/
		);
	});

	test("makes no request", () => {
		const fetch = jest.spyOn(globalThis, "fetch").mockImplementation(() => {
			throw new Error("must not be called");
		});
		try {
			expect(handlers.previewSet({ device: lamp(), characteristic: "On", value: "true" }).ok).toBe(true);
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
		}
	});
});

describe("importLegacy", () => {
	test("converts a whole 1.x config.json", () => {
		const result = handlers.importLegacy({ config: legacy });
		expect(result.ok).toBe(true);
		expect(result.devices.map((device) => device.name)).toContain("Terrace Sensor");
		expect(result.migrated).toBe(result.devices.length);
		const validation = handlers.validate({ config: platform(result.devices) });
		expect(validation.devices.map((device) => device.errors)).toEqual(result.devices.map(() => []));
	});

	test("accepts pasted text, a list of accessories and a single accessory", () => {
		const accessory = legacy.accessories[0];
		expect(handlers.importLegacy({ config: JSON.stringify(legacy) }).ok).toBe(true);
		expect(handlers.importLegacy({ config: [accessory] }).devices).toHaveLength(1);
		expect(handlers.importLegacy({ config: accessory }).devices).toHaveLength(1);
	});

	test("explains text that is not JSON and a configuration without accessories", () => {
		expect(handlers.importLegacy({ config: "{oops" }).error).toMatch(/not valid JSON/);
		expect(handlers.importLegacy({ config: { accessories: [] } }).error).toMatch(/No HttpAdvancedAccessory/);
		expect(handlers.importLegacy({}).error).toMatch(/nothing to import/);
	});
});

describe("cachedStatus", () => {
	test("tells which cached accessories are configured, and which devices HomeKit has not seen yet", () => {
		const pump = handlers.hapUuid("HttpAdvancedPlatform:Pump");
		const result = handlers.cachedStatus({
			config: platform([{ name: "Pump" }, { name: "Fan" }]),
			cached: [
				{ UUID: pump, displayName: "Pump" },
				{ UUID: "00000000-0000-4000-8000-000000000000", displayName: "Gone" },
			],
		});
		expect(result.accessories).toEqual([
			{ uuid: pump, displayName: "Pump", configured: true },
			{ uuid: "00000000-0000-4000-8000-000000000000", displayName: "Gone", configured: false },
		]);
		expect(result.pending).toEqual(["Fan"]);
	});

	test("identifies a device by its id when it has one", () => {
		const result = handlers.cachedStatus({
			config: platform([{ name: "Renamed", id: "pump-1" }]),
			cached: [{ UUID: handlers.hapUuid("HttpAdvancedPlatform:pump-1"), displayName: "Pump" }],
		});
		expect(result.accessories[0].configured).toBe(true);
		expect(result.pending).toEqual([]);
	});

	test("copes with nothing configured and nothing cached", () => {
		expect(handlers.cachedStatus({})).toEqual({ accessories: [], pending: [] });
	});
});

describe("hapUuid", () => {
	test("is the identifier that HAP-NodeJS makes for the same text", () => {
		// Values produced by uuid.generate() of hap-nodejs
		expect(handlers.hapUuid("HttpAdvancedPlatform:Pump")).toBe("22bf2c44-1477-4078-a75f-7c02987d55c7");
		expect(handlers.hapUuid("HttpAdvancedPlatform:a b")).toBe("2d58caa4-4ec4-4271-a9bc-6f5b746005a3");
	});
});

describe("isUiAuthDisabled", () => {
	const directories = [];
	afterAll(() => directories.forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })));

	const write = (config) => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ui-auth-"));
		directories.push(directory);
		const file = path.join(directory, "config.json");
		fs.writeFileSync(file, JSON.stringify(config));
		return file;
	};

	test("is true when the Homebridge UI is set to no login", () => {
		expect(handlers.isUiAuthDisabled(write({ platforms: [{ platform: "config", auth: "none" }] }))).toBe(true);
	});

	test("is false with a login, with another platform that says none, and when the file cannot be read", () => {
		expect(handlers.isUiAuthDisabled(write({ platforms: [{ platform: "config", auth: "form" }] }))).toBe(false);
		expect(handlers.isUiAuthDisabled(write({ platforms: [{ platform: "Other", auth: "none" }] }))).toBe(false);
		expect(handlers.isUiAuthDisabled(write({}))).toBe(false);
		expect(handlers.isUiAuthDisabled(path.join(os.tmpdir(), "does-not-exist.json"))).toBe(false);
		expect(handlers.isUiAuthDisabled(undefined)).toBe(false);
	});
});
