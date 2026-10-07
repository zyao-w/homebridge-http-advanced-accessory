const fs = require("fs");
const path = require("path");
const { buildSchema } = require("../src/schema.js");
const { validateDevice, validatePlatform } = require("../src/validate.js");
const { migrateAccessory, migrateConfig } = require("../src/migrate.js");
const sampleConfig = require("../sample-config.json");

describe("config.schema.json", () => {
	test("is the generated schema (run npm run build:schema)", () => {
		const committed = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config.schema.json"), "utf8"));
		expect(committed).toEqual(buildSchema());
	});

	test("targets the platform", () => {
		const schema = buildSchema();
		expect(schema.pluginAlias).toBe("HttpAdvancedPlatform");
		expect(schema.pluginType).toBe("platform");
	});

	test("has no free-form objects, which the Homebridge UI cannot render and would drop on save", () => {
		const problems = [];
		const walk = (node, where) => {
			if (!node || typeof node !== "object") return;
			if (node.type === "object" && !node.properties) problems.push(where);
			for (const [key, value] of Object.entries(node)) {
				if (value && typeof value === "object") walk(value, `${where}/${key}`);
			}
		};
		walk(buildSchema().schema, "schema");
		expect(problems).toEqual([]);
	});

	test("has no null values, which crash the Homebridge UI form", () => {
		const problems = [];
		const walk = (node, where) => {
			if (node === null) problems.push(where);
			else if (typeof node === "object")
				for (const [key, value] of Object.entries(node)) walk(value, `${where}/${key}`);
		};
		walk(buildSchema().schema, "schema");
		expect(problems).toEqual([]);
	});

	test("has no required or default inside array items, which would create a phantom first item", () => {
		const problems = [];
		const walk = (node, where, insideItems) => {
			if (!node || typeof node !== "object") return;
			if (insideItems && (node.required !== undefined || node.default !== undefined)) problems.push(where);
			for (const [key, value] of Object.entries(node)) {
				if (value && typeof value === "object") walk(value, `${where}/${key}`, insideItems || key === "items");
			}
		};
		walk(buildSchema().schema, "schema", false);
		expect(problems).toEqual([]);
	});

	test("keeps the rarely edited sections closed in the form", () => {
		const { properties } = buildSchema().schema;
		const characteristic = properties.devices.items.properties.characteristics.items.properties;
		const closed = { type: "fieldset", expandable: true, expanded: false };
		expect(properties.defaults["x-schema-form"]).toEqual(closed);
		expect(characteristic.set["x-schema-form"]).toEqual(closed);
		expect(characteristic.props["x-schema-form"]).toEqual(closed);
		expect(characteristic.get.properties.inconclusive["x-schema-form"]).toEqual(closed);
		expect(characteristic.get["x-schema-form"]).toBeUndefined();
	});
});

describe("form conditions", () => {
	// The Homebridge UI calls the condition with the config block (model) and the indexes of the enclosing arrays
	const run = (node, model, arrayIndices) =>
		new Function("model", "arrayIndices", node.condition.functionBody)(model, arrayIndices);
	const characteristic = buildSchema().schema.properties.devices.items.properties.characteristics.items;
	const mapperFields = (location) => {
		const action = location.split(".").reduce((node, key) => node.properties[key], characteristic);
		return action.properties.mappers.items.properties;
	};

	const model = {
		devices: [
			{
				characteristics: [
					{
						get: {
							mappers: [{ type: "regex" }, { type: "static" }],
							inconclusive: { mappers: [{ type: "xpath" }] },
						},
						set: { mappers: [{ type: "script" }] },
					},
					{ get: { mappers: [{ type: "jpath" }] } },
				],
			},
		],
	};

	test.each`
		location              | field           | indexes      | shown
		${"get"}              | ${"regexp"}     | ${[0, 0, 0]} | ${true}
		${"get"}              | ${"capture"}    | ${[0, 0, 0]} | ${true}
		${"get"}              | ${"xpath"}      | ${[0, 0, 0]} | ${false}
		${"get"}              | ${"mapping"}    | ${[0, 0, 1]} | ${true}
		${"get"}              | ${"regexp"}     | ${[0, 0, 1]} | ${false}
		${"get"}              | ${"index"}      | ${[0, 1, 0]} | ${true}
		${"get"}              | ${"jpath"}      | ${[0, 1, 0]} | ${true}
		${"get.inconclusive"} | ${"xpath"}      | ${[0, 0, 0]} | ${true}
		${"get.inconclusive"} | ${"index"}      | ${[0, 0, 0]} | ${true}
		${"get.inconclusive"} | ${"regexp"}     | ${[0, 0, 0]} | ${false}
		${"set"}              | ${"script"}     | ${[0, 0, 0]} | ${true}
		${"set"}              | ${"expression"} | ${[0, 0, 0]} | ${false}
	`("$field of a $location mapper at $indexes is shown: $shown", ({ location, field, indexes, shown }) => {
		expect(run(mapperFields(location)[field], model, indexes)).toBe(shown);
	});

	test("the fields of a mapper without a type, or of a missing mapper, stay hidden", () => {
		const empty = { devices: [{ characteristics: [{ get: { mappers: [{}] } }] }] };
		expect(run(mapperFields("get").regexp, empty, [0, 0, 0])).toBe(false);
		expect(run(mapperFields("get").regexp, { devices: [] }, [0, 0, 0])).toBe(false);
	});

	test("a fallback action is shown only when the config has one", () => {
		const get = characteristic.properties.get.properties.inconclusive;
		const set = characteristic.properties.set.properties.inconclusive;
		expect(run(get, model, [0, 0])).toBe(true);
		expect(run(get, model, [0, 1])).toBe(false);
		expect(run(set, model, [0, 0])).toBe(false);
	});

	test("every mapper field except the type depends on the type", () => {
		for (const location of ["get", "set", "get.inconclusive", "set.inconclusive"]) {
			const fields = mapperFields(location);
			for (const [name, node] of Object.entries(fields)) {
				if (name !== "type") expect(node.condition).toBeDefined();
			}
		}
	});
});

describe("validateDevice", () => {
	const valid = (device) => validateDevice(device).errors;

	test("accepts every device migrated from sample-config.json", () => {
		const { config } = migrateConfig(sampleConfig);
		for (const device of config.platforms[0].devices) {
			expect(valid(device)).toEqual([]);
		}
	});

	test("accepts an accessory that uses every 1.x setting after migration", () => {
		const { device } = migrateAccessory({
			accessory: "HttpAdvancedAccessory",
			name: "Everything",
			service: "Lightbulb",
			optionCharacteristic: ["Brightness"],
			forceRefreshDelay: 5,
			setterDelay: 100,
			debug: true,
			username: "u",
			password: "p",
			bearerToken: "env:T",
			immediately: false,
			timeout: 1000,
			retries: 1,
			cacheTTL: 2,
			maxConcurrent: 3,
			allowUnsafeEval: true,
			props: { Brightness: { minValue: 5, maxValue: 90, minStep: 5, unit: "percentage", validValues: [1, 2] } },
			urls: {
				getBrightness: {
					url: "http://h/a",
					httpMethod: "POST",
					body: "x",
					resultOnError: "0",
					mappers: [
						{ type: "regex", parameters: { regexp: "(\\d)", capture: "1" } },
						{ type: "static", parameters: { mapping: { A: "1" } } },
						{ type: "xpath", parameters: { xpath: "//a/text()", index: 1 } },
						{ type: "jpath", parameters: { jpath: "$.a", index: "0" } },
						{ type: "eval", parameters: { expression: "value + 1" } },
						{ type: "eval", parameters: { expression: "let a = 1; a" } },
					],
					inconclusive: { url: "http://h/b", mappers: [{ type: "regex", parameters: { regexp: "x" } }] },
				},
				setBrightness: { url: "http://h/s?{value}" },
			},
		});
		expect(valid(device)).toEqual([]);
	});

	test("accepts a device without characteristics", () => {
		expect(valid({ name: "A", service: "Switch" })).toEqual([]);
	});

	test("coerces values on a copy and leaves the input untouched", () => {
		const input = {
			name: "A",
			service: "Switch",
			forceRefreshDelay: "5",
			characteristics: [
				{ characteristic: "On", get: { url: "u", mappers: [{ type: "jpath", jpath: "$.a", index: "0" }] } },
			],
		};
		const result = validateDevice(input);
		expect(result.errors).toEqual([]);
		expect(result.device.forceRefreshDelay).toBe(5);
		expect(result.device.characteristics[0].get.mappers[0].index).toBe(0);
		expect(input.forceRefreshDelay).toBe("5");
	});

	test("reports an unknown setting with its location", () => {
		const errors = valid({
			name: "A",
			service: "Switch",
			forceRefreshDelays: 5,
			characteristics: [{ characteristic: "On", get: { url: "u", mappers: [{ type: "regex", regex: "x" }] } }],
		});
		expect(errors).toEqual(
			expect.arrayContaining([
				'has an unknown setting "forceRefreshDelays"',
				'characteristics[0].get.mappers[0] has an unknown setting "regex"',
			])
		);
	});

	test("lists the allowed values of a choice", () => {
		const errors = valid({
			name: "A",
			service: "Switch",
			characteristics: [{ characteristic: "On", get: { url: "u", mappers: [{ type: "eval" }] } }],
		});
		expect(errors).toEqual([
			expect.stringMatching(/mappers\[0\]\.type must be one of: regex, static, xpath, jpath, expression, script/),
		]);
	});

	test("accepts a null HTTP method as the default and rejects unknown ones", () => {
		const device = (httpMethod) => ({
			name: "A",
			service: "Switch",
			characteristics: [{ characteristic: "On", get: { url: "u", httpMethod } }],
		});
		expect(valid(device(null))).toEqual([]);
		expect(valid(device("POST"))).toEqual([]);
		expect(valid(device("FETCH"))).toEqual([
			expect.stringMatching(/get\.httpMethod must be one of: GET, POST, PUT, PATCH, DELETE/),
		]);
	});

	test("reports wrong types", () => {
		expect(valid({ name: "A", service: "Switch", debug: "maybe" })).toEqual([
			expect.stringMatching(/^debug must be boolean/),
		]);
		expect(valid({ name: "A", service: "Switch", characteristics: "On" })).toEqual([
			expect.stringMatching(/^characteristics must be array/),
		]);
	});

	test("rejects a negative delay", () => {
		expect(valid({ name: "A", service: "Switch", setterDelay: -1 })).toEqual([
			expect.stringMatching(/^setterDelay must be >= 0/),
		]);
	});

	test("allows only one level of fallback actions", () => {
		const errors = valid({
			name: "A",
			service: "Switch",
			characteristics: [
				{ characteristic: "On", get: { url: "a", inconclusive: { url: "b", inconclusive: { url: "c" } } } },
			],
		});
		expect(errors).toEqual([expect.stringMatching(/get\.inconclusive has an unknown setting "inconclusive"/)]);
	});
});

describe("validatePlatform", () => {
	test("accepts the platform block written by the migration", () => {
		const { config } = migrateConfig(sampleConfig);
		expect(validatePlatform(config.platforms[0])).toEqual([]);
	});

	test("reports unknown settings and a wrong defaults block", () => {
		expect(validatePlatform({ platform: "HttpAdvancedPlatform", devises: [] })).toEqual([
			'has an unknown setting "devises"',
		]);
		expect(validatePlatform({ defaults: { timeouts: 1 } })).toEqual(['defaults has an unknown setting "timeouts"']);
	});
});
