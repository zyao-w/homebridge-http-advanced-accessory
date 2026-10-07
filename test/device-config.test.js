const { normalizeDevice } = require("../src/device-config.js");
const { migrateConfig } = require("../src/migrate.js");
const sampleConfig = require("./fixtures/config-1x.json");

const base = { name: "Light", service: "Lightbulb" };
const chain = (mappers = [], input) => mappers.reduce((value, mapper) => mapper.map(value), input);

describe("validation", () => {
	test("requires a name and a service", () => {
		expect(() => normalizeDevice({ service: "Switch" })).toThrow('no "name"');
		expect(() => normalizeDevice({ name: "A" })).toThrow('Device "A" has no "service"');
	});

	test("requires a characteristic name", () => {
		expect(() => normalizeDevice({ ...base, characteristics: [{ get: { url: "u" } }] })).toThrow(
			'no "characteristic" name'
		);
	});

	test("rejects a characteristic that is listed twice", () => {
		expect(() =>
			normalizeDevice({ ...base, characteristics: [{ characteristic: "On" }, { characteristic: "On" }] })
		).toThrow('"On" is listed twice');
	});

	test("rejects an action without a url", () => {
		expect(() => normalizeDevice({ ...base, characteristics: [{ characteristic: "On", get: {} }] })).toThrow(
			"On get has no url"
		);
	});

	test("accepts a device without characteristics", () => {
		expect(normalizeDevice(base).characteristics).toEqual([]);
	});
});

describe("settings", () => {
	test("device settings win over platform defaults", () => {
		const device = normalizeDevice(
			{ ...base, timeout: 1000, username: "device" },
			{ timeout: 5000, retries: 2, username: "default", password: "p" }
		);
		expect(device.http).toMatchObject({ timeout: 1000, retries: 2 });
		expect(device.auth).toMatchObject({ username: "device", password: "p" });
	});

	test("applies defaults", () => {
		const device = normalizeDevice(base);
		expect(device).toMatchObject({ forceRefreshDelay: 0, setterDelay: 0, optionCharacteristic: [], authError: null });
		expect(device.auth).toEqual({ username: "", password: "", bearerToken: "", immediately: true });
	});

	test("cacheTTL defaults to forceRefreshDelay and can be overridden", () => {
		expect(normalizeDevice({ ...base, forceRefreshDelay: 5 }).http.cacheTTL).toBe(5);
		expect(normalizeDevice({ ...base, forceRefreshDelay: 5, cacheTTL: 0 }).http.cacheTTL).toBe(0);
		expect(normalizeDevice(base, { forceRefreshDelay: 7 }).http.cacheTTL).toBe(7);
	});

	test("resolves the bearer token from the defaults", () => {
		expect(normalizeDevice(base, { bearerToken: " tok\n" }).auth.bearerToken).toBe("tok");
	});

	test("reports an unreadable bearer token instead of throwing", () => {
		const device = normalizeDevice({ ...base, bearerToken: "env:HHAA_DEVICE_MISSING" });
		expect(device.authError.message).toMatch("HHAA_DEVICE_MISSING");
		expect(device.auth.bearerToken).toBe("");
	});
});

describe("actions", () => {
	const device = (entry, options) => normalizeDevice({ ...base, characteristics: [entry] }, {}, options);

	test("applies action defaults and keeps props", () => {
		const { characteristics } = device({
			characteristic: "Brightness",
			get: { url: "http://h/s" },
			props: { minValue: 5 },
		});
		expect(characteristics[0]).toEqual({
			name: "Brightness",
			props: { minValue: 5 },
			get: { url: "http://h/s", httpMethod: "GET", body: "", resultOnError: undefined },
		});
	});

	test("builds flat mappers, including a static mapping given as pairs", () => {
		const { characteristics } = device({
			characteristic: "On",
			get: {
				url: "u",
				mappers: [
					{ type: "regex", regexp: "mode=(\\d)" },
					{ type: "static", mapping: [{ from: "3", to: "on" }] },
				],
			},
		});
		expect(chain(characteristics[0].get.mappers, "pow=1,mode=3")).toBe("on");
		expect(chain(characteristics[0].get.mappers, "pow=1,mode=9")).toBe("9");
	});

	test("a static mapping can map to falsy values", () => {
		const { characteristics } = device({
			characteristic: "On",
			get: { url: "u", mappers: [{ type: "static", mapping: [{ from: "OFF", to: 0 }] }] },
		});
		expect(chain(characteristics[0].get.mappers, "OFF")).toBe(0);
	});

	test("an expression mapper evaluates against the value", () => {
		const { characteristics } = device({
			characteristic: "On",
			get: { url: "u", mappers: [{ type: "expression", expression: 'value == 1 ? "on" : "off"' }] },
		});
		expect(chain(characteristics[0].get.mappers, 1)).toBe("on");
		expect(chain(characteristics[0].get.mappers, 0)).toBe("off");
	});

	test("an expression mapper sees the device state by characteristic name", () => {
		const normalized = normalizeDevice({
			...base,
			characteristics: [
				{
					characteristic: "On",
					get: { url: "u", mappers: [{ type: "expression", expression: "state.Target + value" }] },
				},
			],
		});
		normalized.state.Target = 10;
		expect(chain(normalized.characteristics[0].get.mappers, 5)).toBe(15);
	});

	test("an expression the language does not offer is refused when the device loads", () => {
		const entry = (expression) => ({
			characteristic: "On",
			get: { url: "u", mappers: [{ type: "expression", expression }] },
		});
		expect(() => device(entry("value.toFixed(1)"))).toThrow(/Only the built-in functions/);
		expect(() => device(entry("let a = 1"))).toThrow(/Unexpected "="/);
		expect(() => device(entry("process.exit()"))).toThrow(/Unknown name "process"/);
		// allowUnsafeEval does not widen the expression language; script mappers are for that
		expect(() =>
			normalizeDevice({ ...base, allowUnsafeEval: true, characteristics: [entry("value.toFixed(1)")] })
		).toThrow();
	});

	test("a script mapper needs allowUnsafeEval", () => {
		const entry = { characteristic: "On", get: { url: "u", mappers: [{ type: "script", script: "value * 2" }] } };
		expect(() => device(entry)).toThrow('needs "allowUnsafeEval": true');
		expect(() => normalizeDevice({ ...base, allowUnsafeEval: false, characteristics: [entry] })).toThrow(
			"allowUnsafeEval"
		);
	});

	test("a script mapper runs JavaScript and sees the device state once allowed", () => {
		const entry = {
			characteristic: "On",
			get: {
				url: "u",
				mappers: [
					{
						type: "script",
						script: "let n = parseFloat(value); if (!Number.isFinite(n)) n = 0; self.state.Target + n",
					},
				],
			},
		};
		const normalized = normalizeDevice({ ...base, allowUnsafeEval: true, characteristics: [entry] });
		normalized.state.Target = 10;
		expect(normalized.allowUnsafeEval).toBe(true);
		expect(chain(normalized.characteristics[0].get.mappers, "5")).toBe(15);
		expect(chain(normalized.characteristics[0].get.mappers, "x")).toBe(10);
	});

	test("allowUnsafeEval can come from the platform defaults", () => {
		const entry = { characteristic: "On", get: { url: "u", mappers: [{ type: "script", script: "value" }] } };
		expect(() => normalizeDevice({ ...base, characteristics: [entry] }, { allowUnsafeEval: true })).not.toThrow();
	});

	test("the 1.x eval mapper type is no longer accepted", () => {
		const warn = jest.fn();
		const { characteristics } = device(
			{ characteristic: "On", get: { url: "u", mappers: [{ type: "eval", expression: "value" }] } },
			{ warn }
		);
		expect(characteristics[0].get.mappers).toEqual([]);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('"eval"'));
	});

	test("skips unknown mapper types and reports them", () => {
		const warn = jest.fn();
		const { characteristics } = device(
			{ characteristic: "On", get: { url: "u", mappers: [{ type: "nope" }] } },
			{ warn }
		);
		expect(characteristics[0].get.mappers).toEqual([]);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('"nope"'));
	});

	test("builds nested inconclusive actions", () => {
		const { characteristics } = device({
			characteristic: "On",
			get: { url: "a", inconclusive: { url: "b", inconclusive: { url: "c" } } },
		});
		expect(characteristics[0].get.inconclusive.inconclusive.url).toBe("c");
	});

	describe("bearerToken override", () => {
		test("is resolved per action", () => {
			process.env.HHAA_ACTION_TOKEN = " from-env ";
			try {
				const { characteristics } = device({
					characteristic: "On",
					get: { url: "u", bearerToken: "env:HHAA_ACTION_TOKEN" },
					set: { url: "u", bearerToken: "" },
				});
				expect(characteristics[0].get.auth).toEqual({ bearerToken: "from-env" });
				// An empty override switches the token off for this action
				expect(characteristics[0].set.auth).toEqual({ bearerToken: "" });
			} finally {
				delete process.env.HHAA_ACTION_TOKEN;
			}
		});

		test("is absent without an override", () => {
			expect(device({ characteristic: "On", get: { url: "u" } }).characteristics[0].get).not.toHaveProperty("auth");
		});

		test("reports an unreadable source on the action", () => {
			const { characteristics } = device({
				characteristic: "On",
				get: { url: "u", bearerToken: "env:HHAA_ACTION_MISSING" },
			});
			expect(characteristics[0].get.auth.error.message).toMatch("HHAA_ACTION_MISSING");
		});
	});
});

describe("equivalence with the 1.x configuration", () => {
	const samples = [
		"ARMED",
		"NORMAL",
		"ALARM",
		"DISARMED",
		"pow=0,mode=3",
		"pow=1,mode=4",
		"0",
		"1",
		"2",
		"3",
		"<root><status>ALARM</status><generic>2</generic></root>",
		'{"power":"on","u":1}',
	];

	let silence;
	beforeAll(() => {
		silence = [jest.spyOn(console, "error").mockImplementation(), jest.spyOn(console, "warn").mockImplementation()];
	});
	afterAll(() => silence.forEach((spy) => spy.mockRestore()));

	const outcome = (mappers, input) => {
		try {
			return { value: chain(mappers, input) };
		} catch (error) {
			return { error: error.message };
		}
	};

	// The snapshot was recorded while the 1.x code still ran next to it and gave identical results
	test("every action of sample-config.json maps the same inputs to the same values", () => {
		const { config } = migrateConfig(sampleConfig);
		const devices = config.platforms[0].devices;
		expect(devices).toHaveLength(sampleConfig.accessories.length);

		const recorded = {};
		sampleConfig.accessories.forEach((accessory, index) => {
			const device = normalizeDevice(devices[index]);

			for (const key of Object.keys(accessory.urls)) {
				const [, kind, name] = /^(get|set)(.+)$/.exec(key);
				const action = device.characteristics.find((c) => c.name === name)[kind];
				recorded[`${accessory.name} ${key}`] = {
					url: action.url,
					outcomes: Object.fromEntries(samples.map((input) => [input, outcome(action.mappers, input)])),
				};
			}
		});
		expect(Object.keys(recorded).length).toBeGreaterThan(5);
		expect(recorded).toMatchSnapshot();
	});
});
