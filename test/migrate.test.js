const { migrateAccessory, migrateConfig } = require("../src/migrate.js");

const find = (device, name) => device.characteristics.find((c) => c.characteristic === name);

describe("migrateAccessory", () => {
	test("groups getXxx and setXxx actions by characteristic, keeping the order", () => {
		const { device } = migrateAccessory({
			accessory: "HttpAdvancedAccessory",
			name: "Light",
			service: "Lightbulb",
			urls: {
				getOn: { url: "http://h/status" },
				setBrightness: { url: "http://h/b?v={value}", httpMethod: "POST", body: "x" },
				setOn: { url: "http://h/on?v={value}" },
				getBrightness: { url: "http://h/status", resultOnError: "0" },
			},
		});

		expect(device.characteristics.map((c) => c.characteristic)).toEqual(["On", "Brightness"]);
		expect(find(device, "On")).toEqual({
			characteristic: "On",
			get: { url: "http://h/status" },
			set: { url: "http://h/on?v={value}" },
		});
		expect(find(device, "Brightness").set).toMatchObject({ httpMethod: "POST", body: "x" });
		expect(find(device, "Brightness").get).toMatchObject({ resultOnError: "0" });
	});

	test("copies device settings and drops the accessory marker", () => {
		const { device, warnings } = migrateAccessory({
			accessory: "HttpAdvancedAccessory",
			name: "A",
			service: "Switch",
			forceRefreshDelay: 5,
			setterDelay: 100,
			username: "u",
			password: "p",
			bearerToken: "env:T",
			immediately: false,
			debug: true,
			timeout: 2000,
			retries: 1,
			cacheTTL: 3,
			maxConcurrent: 2,
			optionCharacteristic: ["Brightness"],
		});
		expect(device).toEqual({
			name: "A",
			service: "Switch",
			forceRefreshDelay: 5,
			setterDelay: 100,
			username: "u",
			password: "p",
			bearerToken: "env:T",
			immediately: false,
			debug: true,
			timeout: 2000,
			retries: 1,
			cacheTTL: 3,
			maxConcurrent: 2,
			optionCharacteristic: ["Brightness"],
			characteristics: [],
		});
		expect(warnings).toEqual([]);
	});

	test("replaces uriCallsDelay with maxConcurrent", () => {
		const { device, warnings } = migrateAccessory({ name: "A", service: "Switch", uriCallsDelay: 200 });
		expect(device.maxConcurrent).toBe(1);
		expect(device).not.toHaveProperty("uriCallsDelay");
		expect(warnings[0]).toMatch("uriCallsDelay");
	});

	test("keeps an explicit maxConcurrent next to uriCallsDelay", () => {
		const { device } = migrateAccessory({ name: "A", service: "Switch", uriCallsDelay: 200, maxConcurrent: 3 });
		expect(device.maxConcurrent).toBe(3);
	});

	test("warns about settings it cannot carry over", () => {
		const { device, warnings } = migrateAccessory({
			name: "A",
			service: "Switch",
			manufacturer: "Acme",
			urls: { refresh: { url: "http://h" } },
		});
		expect(device).not.toHaveProperty("manufacturer");
		expect(warnings).toEqual(
			expect.arrayContaining([expect.stringContaining('"manufacturer"'), expect.stringContaining('"refresh"')])
		);
	});

	test("moves props into their characteristic and drops unknown ones", () => {
		const { device, warnings } = migrateAccessory({
			name: "A",
			service: "Lightbulb",
			urls: { getBrightness: { url: "http://h" } },
			props: { Brightness: { minValue: 10, maxValue: 90, minStep: 5, odd: 1 }, Hue: { minValue: 0 } },
		});
		expect(find(device, "Brightness").props).toEqual({ minValue: 10, maxValue: 90, minStep: 5 });
		expect(find(device, "Hue")).toEqual({ characteristic: "Hue", props: { minValue: 0 } });
		expect(warnings).toEqual([expect.stringContaining('"odd"')]);
	});

	describe("mappers", () => {
		const migrateMappers = (mappers) =>
			migrateAccessory({ name: "A", service: "S", urls: { getOn: { url: "u", mappers } } });
		const mappersOf = (result) => find(result.device, "On").get.mappers;

		test("flattens parameters and turns a static dictionary into pairs", () => {
			const result = migrateMappers([
				{ type: "regex", parameters: { regexp: "(\\d)", capture: "1" } },
				{ type: "static", parameters: { mapping: { ARMED: "1", NORMAL: "0" } } },
				{ type: "xpath", parameters: { xpath: "//a/text()", index: 1 } },
				{ type: "jpath", parameters: { jpath: "$.a", index: "0" } },
				{ type: "eval", parameters: { expression: 'value === "OK" ? 1 : 0' } },
			]);
			expect(mappersOf(result)).toEqual([
				{ type: "regex", regexp: "(\\d)", capture: "1" },
				{
					type: "static",
					mapping: [
						{ from: "ARMED", to: "1" },
						{ from: "NORMAL", to: "0" },
					],
				},
				{ type: "xpath", xpath: "//a/text()", index: 1 },
				{ type: "jpath", jpath: "$.a", index: "0" },
				{ type: "expression", expression: 'value === "OK" ? 1 : 0' },
			]);
			expect(result.warnings).toEqual([]);
		});

		test("drops unknown mapper types with a warning", () => {
			const result = migrateMappers([{ type: "nope", parameters: {} }]);
			expect(mappersOf(result)).toEqual([]);
			expect(result.warnings[0]).toMatch('"nope"');
		});

		test.each`
			script
			${"let v = parseFloat(value); value = v"}
			${"value = value * 2"}
			${"obj?.data?.pm25"}
			${"if (value) { 1 } else { 2 }"}
			${"try { JSON.parse(value) } catch (e) { 0 }"}
		`("turns $script into a script mapper that needs allowUnsafeEval", ({ script }) => {
			const result = migrateMappers([{ type: "eval", parameters: { expression: script } }]);
			expect(mappersOf(result)).toEqual([{ type: "script", script }]);
			expect(result.warnings[0]).toMatch('"allowUnsafeEval": true');
		});

		test.each`
			expression
			${'value == 1 ? "on" : "off"'}
			${"value <= 12 ? 1 : value <= 35 ? 2 : 3"}
			${"(value - 30) * 100 / 69 >= 50"}
			${"state.getTarget + 1"}
			${"Math.round(value / 2)"}
			${"toNumber(value) > 3 ? 'on' : 'off'"}
		`("keeps $expression as an expression mapper", ({ expression }) => {
			const result = migrateMappers([{ type: "eval", parameters: { expression } }]);
			expect(mappersOf(result)[0].type).toBe("expression");
			expect(result.warnings).toEqual([]);
		});

		test("renames state keys inside scripts and expressions", () => {
			const result = migrateMappers([{ type: "eval", parameters: { expression: "self.state.getTarget + value" } }]);
			expect(mappersOf(result)).toEqual([{ type: "expression", expression: "state.Target + value" }]);
		});

		test("allowUnsafeEval is carried over to the device", () => {
			const { device } = migrateAccessory({ name: "A", service: "S", allowUnsafeEval: true });
			expect(device.allowUnsafeEval).toBe(true);
		});
	});

	test("migrates nested inconclusive actions", () => {
		const { device } = migrateAccessory({
			name: "A",
			service: "S",
			urls: {
				getOn: {
					url: "http://h/a",
					mappers: [{ type: "static", parameters: { mapping: { X: "inconclusive" } } }],
					inconclusive: { url: "http://h/b", mappers: [{ type: "regex", parameters: { regexp: "(.)" } }] },
				},
			},
		});
		const inconclusive = find(device, "On").get.inconclusive;
		expect(inconclusive.url).toBe("http://h/b");
		expect(inconclusive.mappers).toEqual([{ type: "regex", regexp: "(.)" }]);
	});

	test("drops an inconclusive action nested in the fallback action, which 2.0 does not allow", () => {
		const { device, warnings } = migrateAccessory({
			name: "A",
			service: "S",
			urls: {
				getOn: {
					url: "http://h/a",
					inconclusive: { url: "http://h/b", inconclusive: { url: "http://h/c" } },
				},
			},
		});
		const fallback = find(device, "On").get.inconclusive;
		expect(fallback.url).toBe("http://h/b");
		expect(fallback).not.toHaveProperty("inconclusive");
		expect(warnings).toEqual([expect.stringMatching(/inconclusive action inside the fallback action/)]);
	});

	describe("templates", () => {
		const migrateUrl = (url, body) => migrateAccessory({ name: "A", service: "S", urls: { setOn: { url, body } } });

		test("renames state keys from action names to characteristic names", () => {
			const { device } = migrateUrl(
				"http://h/set?{value}&t=${state.getTargetTemperature * 9/5 + 32}",
				'{"p":"${state["getActive"]}"}'
			);
			const set = find(device, "On").set;
			expect(set.url).toBe("http://h/set?{value}&t=${state.TargetTemperature * 9/5 + 32}");
			expect(set.body).toBe('{"p":"${state["Active"]}"}');
		});

		test("leaves plain placeholders and simple expressions without warnings", () => {
			const result = migrateUrl('http://h/p?power=${value==1?"on":"standby"}');
			expect(result.warnings).toEqual([]);
		});

		test("flags JavaScript the expression language does not offer", () => {
			const result = migrateUrl("http://h/p?v=${value.toFixed(1)}");
			expect(result.warnings[0]).toMatch("Only the built-in functions");
			expect(result.warnings[0]).toMatch('"allowUnsafeEval": true');
		});

		test("does not flag templates the expression language handles", () => {
			expect(migrateUrl("http://h/p?v=${Math.round(value)}").warnings).toEqual([]);
		});
	});
});

describe("migrateConfig", () => {
	const accessory = (name) => ({
		accessory: "HttpAdvancedAccessory",
		name,
		service: "Switch",
		urls: { getOn: { url: "http://h/" + name } },
	});

	test("moves the accessories into one platform and keeps everything else", () => {
		const other = { accessory: "SomethingElse", name: "X" };
		const result = migrateConfig({
			bridge: { name: "Homebridge" },
			accessories: [accessory("A"), other, accessory("B")],
			platforms: [{ platform: "Other" }],
		});

		expect(result.migrated).toBe(2);
		expect(result.config.bridge).toEqual({ name: "Homebridge" });
		expect(result.config.accessories).toEqual([other]);
		expect(result.config.platforms).toEqual([
			{ platform: "Other" },
			{
				platform: "HttpAdvancedPlatform",
				name: "HTTP Advanced",
				devices: [expect.objectContaining({ name: "A" }), expect.objectContaining({ name: "B" })],
			},
		]);
	});

	test("accepts the plugin-qualified accessory name", () => {
		const result = migrateConfig({
			accessories: [{ ...accessory("A"), accessory: "homebridge-http-advanced-accessory-zyao.HttpAdvancedAccessory" }],
		});
		expect(result.migrated).toBe(1);
	});

	test("does not add a platform when there is nothing to migrate", () => {
		const input = { accessories: [{ accessory: "SomethingElse" }], platforms: [] };
		const result = migrateConfig(input);
		expect(result.migrated).toBe(0);
		expect(result.config).toEqual(input);
	});

	test("does not modify its input", () => {
		const input = { accessories: [accessory("A")] };
		const copy = JSON.parse(JSON.stringify(input));
		migrateConfig(input);
		expect(input).toEqual(copy);
	});
});
