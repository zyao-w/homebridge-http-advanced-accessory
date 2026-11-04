const fs = require("fs");
const path = require("path");
const { buildSchema, buildDeviceFormSchema } = require("../src/schema.js");
const { validateDevice, validatePlatform } = require("../src/validate.js");
const { normalizeDevice } = require("../src/device-config.js");
const { migrateAccessory, migrateConfig } = require("../src/migrate.js");
const sampleConfig = require("./fixtures/config-1x.json");
const platformSample = require("../sample-config.json");

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

	test("the fields of a mapper in an additional service use the position of that service", () => {
		const service =
			buildSchema().schema.properties.devices.items.properties.additionalServices.items.properties.characteristics
				.items;
		const fields = (location) =>
			location.split(".").reduce((node, key) => node.properties[key], service).properties.mappers.items.properties;
		const withServices = {
			devices: [
				{
					characteristics: [{ get: { mappers: [{ type: "script" }] } }],
					additionalServices: [
						{
							characteristics: [
								{ get: { mappers: [{ type: "jpath" }], inconclusive: { mappers: [{ type: "regex" }] } } },
							],
						},
						{ characteristics: [{ get: { mappers: [{ type: "regex" }, { type: "scale" }] } }] },
					],
				},
			],
		};

		// indexes: device, service, characteristic, mapper
		expect(run(fields("get").jpath, withServices, [0, 0, 0, 0])).toBe(true);
		expect(run(fields("get").regexp, withServices, [0, 0, 0, 0])).toBe(false);
		expect(run(fields("get").regexp, withServices, [0, 1, 0, 0])).toBe(true);
		expect(run(fields("get").inputMin, withServices, [0, 1, 0, 1])).toBe(true);
		expect(run(fields("get").inputMin, withServices, [0, 1, 0, 0])).toBe(false);
		expect(run(fields("get.inconclusive").regexp, withServices, [0, 0, 0, 0])).toBe(true);
		// the mapper of the device itself is not the one at the same indexes
		expect(run(fields("get").script, withServices, [0, 0, 0, 0])).toBe(false);

		const fallback = service.properties.get.properties.inconclusive;
		expect(run(fallback, withServices, [0, 0, 0])).toBe(true);
		expect(run(fallback, withServices, [0, 1, 0])).toBe(false);
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
			expect.stringMatching(
				/mappers\[0\]\.type must be one of: regex, static, xpath, jpath, number, scale, expression, script/
			),
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

	test("validates additional services like the device itself", () => {
		const entry = (service) => ({ name: "A", service: "Switch", additionalServices: [service] });
		const humidity = {
			id: "humidity",
			service: "HumiditySensor",
			name: "Humidity",
			optionCharacteristic: ["Foo"],
			characteristics: [
				{
					characteristic: "CurrentRelativeHumidity",
					get: { url: "u", mappers: [{ type: "regex", regexp: "(\\d+)" }] },
				},
			],
		};
		expect(valid(entry(humidity))).toEqual([]);
		expect(valid(entry({ ...humidity, colour: "red" }))).toEqual([
			'additionalServices[0] has an unknown setting "colour"',
		]);
		expect(
			valid(
				entry({
					...humidity,
					characteristics: [{ characteristic: "X", get: { url: "u", mappers: [{ type: "nope" }] } }],
				})
			)
		).toEqual([
			expect.stringMatching(/additionalServices\[0\]\.characteristics\[0\]\.get\.mappers\[0\]\.type must be one of/),
		]);
		expect(valid(entry({ ...humidity, characteristics: "On" }))).toEqual([
			expect.stringMatching(/^additionalServices\[0\]\.characteristics must be array/),
		]);
		expect(valid({ name: "A", service: "Switch", additionalServices: "battery" })).toEqual([
			expect.stringMatching(/^additionalServices must be array/),
		]);
	});

	test("accepts the accessory information settings", () => {
		expect(valid({ name: "A", service: "Switch", manufacturer: "Acme", model: "M1", serialNumber: "SN-1" })).toEqual(
			[]
		);
		expect(valid({ name: "A", service: "Switch", manufacturer: 5 })).toEqual([]);
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

describe("the list of characteristic names in the form", () => {
	const { CHARACTERISTICS } = require("../src/hap-names.js");
	const collect = (node, found = { single: [], options: [], optionLists: [] }) => {
		if (!node || typeof node !== "object") return found;
		if (node.properties && node.properties.characteristic) found.single.push(node.properties.characteristic);
		if (node.properties && node.properties.optionCharacteristic) {
			found.optionLists.push(node.properties.optionCharacteristic);
			found.options.push(node.properties.optionCharacteristic.items);
		}
		Object.values(node).forEach((value) => collect(value, found));
		return found;
	};

	test("is a fixed list wherever a characteristic is named, in the form of the plugin and of one device", () => {
		const { OPTIONAL_CHARACTERISTICS } = require("../src/schema.js");
		for (const schema of [buildSchema().schema, buildDeviceFormSchema().schema]) {
			const { single, options } = collect(schema);
			// The characteristics and the optional characteristics, of the device and of an additional service
			expect(single).toHaveLength(2);
			expect(options).toHaveLength(2);
			for (const node of single) {
				expect(node.enum).toBe(CHARACTERISTICS);
				expect(node.type).toBe("string");
			}
			// Only what can be optional on some service is offered as optional
			for (const node of options) {
				expect(node.enum).toBe(OPTIONAL_CHARACTERISTICS);
				expect(node.type).toBe("string");
			}
		}
	});

	test("shows the optional characteristics as rows with a dropdown, and not as one checkbox for each name", () => {
		for (const schema of [buildSchema().schema, buildDeviceFormSchema().schema]) {
			const { optionLists } = collect(schema);
			expect(optionLists).toHaveLength(2);
			for (const list of optionLists) {
				expect(list.type).toBe("array");
				expect(list.uniqueItems).toBe(true);
				// The form turns an array of names from a list into checkboxes, unless the widget is named
				expect(list["x-schema-form"]).toEqual({ type: "array", listItems: 0 });
				// Each row is a dropdown of the names
				expect(list.items.type).toBe("string");
				expect(Array.isArray(list.items.enum)).toBe(true);
			}
		}
	});

	test("offers as optional only what is optional on some service", () => {
		const { SERVICES } = require("../src/hap-names.js");
		const { OPTIONAL_CHARACTERISTICS } = require("../src/schema.js");
		const optional = new Set(Object.values(SERVICES).flatMap((service) => service.optional));
		expect(new Set(OPTIONAL_CHARACTERISTICS)).toEqual(optional);
		expect(OPTIONAL_CHARACTERISTICS.length).toBeLessThan(CHARACTERISTICS.length);
		expect(OPTIONAL_CHARACTERISTICS).toEqual(expect.arrayContaining(["Brightness", "BatteryLevel", "PM2.5Density"]));
		expect(OPTIONAL_CHARACTERISTICS).not.toContain("On");
	});

	test("has each name once, in order, with nothing that the plugin could not match", () => {
		expect(new Set(CHARACTERISTICS).size).toBe(CHARACTERISTICS.length);
		expect(CHARACTERISTICS).toEqual([...CHARACTERISTICS].sort((a, b) => a.localeCompare(b, "en")));
		expect(CHARACTERISTICS.filter((name) => /[\s-]/.test(name) || name === "")).toEqual([]);
		expect(CHARACTERISTICS.length).toBeGreaterThan(200);
		// The names of the services that the wizard sets up
		expect(CHARACTERISTICS).toEqual(
			expect.arrayContaining(["On", "Brightness", "CurrentHeaterCoolerState", "PM2.5Density"])
		);
	});

	test("the wizard only uses names from it", () => {
		const Wizard = require("../homebridge-ui/public/wizard.js");
		const used = [...Object.values(Wizard.KINDS).map((kind) => kind.characteristic), "Brightness"];
		expect(used.filter((name) => !CHARACTERISTICS.includes(name))).toEqual([]);
	});

	test("the wizard sets up real services, with characteristics that they have", () => {
		const { SERVICES } = require("../src/hap-names.js");
		const Wizard = require("../homebridge-ui/public/wizard.js");
		const wrong = [];
		const check = (service, characteristic) => {
			const has = SERVICES[service] && [...SERVICES[service].required, ...SERVICES[service].optional];
			if (!has || !has.includes(characteristic)) wrong.push(`${service} ${characteristic}`);
		};
		for (const kind of Object.values(Wizard.KINDS)) check(kind.service, kind.characteristic);
		// A light also reads and sets the brightness
		check("Lightbulb", "Brightness");
		expect(wrong).toEqual([]);
	});

	test("is not a limit: a name that is not in it still validates and loads", () => {
		const device = {
			name: "Custom",
			service: "Switch",
			optionCharacteristic: ["SomethingNew"],
			characteristics: [{ characteristic: "SomethingNew", get: { url: "http://x" } }],
		};
		expect(validateDevice(device).errors).toEqual([]);
		expect(() => normalizeDevice(device)).not.toThrow();
		// The form schema itself does hold the list
		expect(
			buildSchema().schema.properties.devices.items.properties.characteristics.items.properties.characteristic.enum
		).toContain("On");
	});
});

describe("the list of services in the form", () => {
	const { SERVICES } = require("../src/hap-names.js");
	const { SERVICE_NAMES } = require("../src/schema.js");

	const servicesIn = (node, found = []) => {
		if (!node || typeof node !== "object") return found;
		if (node.properties && node.properties.service) found.push(node.properties.service);
		Object.values(node).forEach((value) => servicesIn(value, found));
		return found;
	};

	test("is a fixed list for the service of a device and of an additional service, in both forms", () => {
		for (const schema of [buildSchema().schema, buildDeviceFormSchema().schema]) {
			const found = servicesIn(schema);
			expect(found).toHaveLength(2);
			for (const node of found) {
				expect(node.enum).toBe(SERVICE_NAMES);
				expect(node.type).toBe("string");
			}
		}
	});

	test("has the services that HomeKit has, in order, without the one that the plugin adds itself", () => {
		expect(SERVICE_NAMES).toEqual([...SERVICE_NAMES].sort((a, b) => a.localeCompare(b, "en")));
		expect(SERVICE_NAMES).toEqual(expect.arrayContaining(["Switch", "Lightbulb", "TemperatureSensor", "Battery"]));
		expect(SERVICE_NAMES).not.toContain("AccessoryInformation");
		// The old name of a renamed service is not offered next to the new one
		expect(SERVICE_NAMES).not.toContain("BatteryService");
		expect(SERVICE_NAMES.length).toBeGreaterThan(60);
		expect(SERVICE_NAMES).toEqual(Object.keys(SERVICES).sort((a, b) => a.localeCompare(b, "en")));
	});

	test("every service has the characteristics it always has, none twice", () => {
		for (const [name, service] of Object.entries(SERVICES)) {
			expect({ name, required: service.required.length > 0 }).toEqual({ name, required: true });
			expect({ name, overlap: service.optional.filter((one) => service.required.includes(one)) }).toEqual({
				name,
				overlap: [],
			});
		}
	});

	test("is not a limit: a service that is not in it still validates", () => {
		const device = { name: "Custom", service: "SomethingNew", characteristics: [] };
		expect(validateDevice(device).errors).toEqual([]);
		// The device reports it when it loads, as before
		expect(buildSchema().schema.properties.devices.items.properties.service.enum).toContain("Switch");
	});
});

describe("lists in the form", () => {
	const { buildDefaultsFormSchema } = require("../src/schema.js");
	const handlers = require("../src/ui-handlers.js");

	const lists = (node, path = "", found = []) => {
		if (!node || typeof node !== "object") return found;
		if (node.type === "array" && node.items) found.push({ path, node });
		for (const [key, value] of Object.entries(node)) if (key !== "enum") lists(value, `${path}/${key}`, found);
		return found;
	};

	test("show no empty row for a list without entries: the form adds one row to every list by default", () => {
		const schemas = {
			platform: buildSchema().schema,
			device: buildDeviceFormSchema().schema,
			deviceOfService: handlers.deviceSchema({ device: { service: "Lightbulb" } }).schema,
			defaults: buildDefaultsFormSchema().schema,
		};
		for (const [name, schema] of Object.entries(schemas)) {
			const found = lists(schema);
			expect(found.length).toBeGreaterThan(0);
			const blank = found.filter(({ node }) => !(node["x-schema-form"] && node["x-schema-form"].listItems === 0));
			expect({ name, blank: blank.map(({ path }) => path) }).toEqual({ name, blank: [] });
		}
	});

	test("include the headers, the additional services and the devices that were seen as empty rows", () => {
		const device = buildSchema().schema.properties.devices.items.properties;
		expect(device.headers["x-schema-form"]).toEqual({ listItems: 0 });
		expect(device.additionalServices["x-schema-form"]).toEqual({ listItems: 0 });
		expect(device.characteristics["x-schema-form"]).toEqual({ listItems: 0 });
		expect(buildSchema().schema.properties.devices["x-schema-form"]).toEqual({ listItems: 0 });
	});

	test("keep the settings that other parts of the schema put on a list", () => {
		const options = buildSchema().schema.properties.devices.items.properties.optionCharacteristic;
		expect(options["x-schema-form"]).toEqual({ type: "array", listItems: 0 });
	});

	test("do not change what the lists hold", () => {
		const strip = (node) => JSON.parse(JSON.stringify(node, (key, value) => (key === "listItems" ? undefined : value)));
		const withRows = strip(buildSchema().schema);
		expect(JSON.stringify(withRows)).not.toContain('"listItems"');
		// Only x-schema-form objects were touched, and they are the same shape as before for what was there
		expect(buildSchema().schema.properties.defaults["x-schema-form"]).toEqual({
			type: "fieldset",
			expandable: true,
			expanded: false,
		});
	});
});

describe("validatePlatform", () => {
	test("accepts the platform block written by the migration", () => {
		const { config } = migrateConfig(sampleConfig);
		expect(validatePlatform(config.platforms[0])).toEqual([]);
	});

	test("the shipped sample-config.json is valid and loads", () => {
		const [platform] = platformSample.platforms;
		expect(validatePlatform(platform)).toEqual([]);
		for (const device of platform.devices) {
			expect(validateDevice(device).errors).toEqual([]);
			expect(() => normalizeDevice(device, platform.defaults)).not.toThrow();
		}
	});

	test("reports unknown settings and a wrong defaults block", () => {
		expect(validatePlatform({ platform: "HttpAdvancedPlatform", devises: [] })).toEqual([
			'has an unknown setting "devises"',
		]);
		expect(validatePlatform({ defaults: { timeouts: 1 } })).toEqual(['defaults has an unknown setting "timeouts"']);
	});

	test("accepts the child bridge settings that Homebridge adds to the block", () => {
		const block = {
			platform: "HttpAdvancedPlatform",
			name: "x",
			_bridge: { username: "0E:12:34:56:78:9A", port: 35000 },
		};
		expect(validatePlatform(block)).toEqual([]);
		expect(validatePlatform({ ...block, _bridge: "no" })).toEqual(["_bridge must be object"]);
	});
});
