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
