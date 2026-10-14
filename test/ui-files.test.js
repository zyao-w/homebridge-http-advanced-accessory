const fs = require("fs");
const path = require("path");
const I18n = require("../homebridge-ui/public/i18n.js");
const Wizard = require("../homebridge-ui/public/wizard.js");
const { buildSchema, buildDeviceFormSchema, buildDefaultsFormSchema } = require("../src/schema.js");
const { validateDevice } = require("../src/validate.js");

const publicDir = path.join(__dirname, "..", "homebridge-ui", "public");
const read = (file) => fs.readFileSync(path.join(publicDir, file), "utf8");

describe("the words of the custom UI", () => {
	const { en, "zh-TW": zhTW } = I18n.messages;

	test("English and Traditional Chinese have the same texts", () => {
		expect(Object.keys(zhTW).sort()).toEqual(Object.keys(en).sort());
	});

	test("both languages use the same placeholders in each text", () => {
		const placeholders = (text) => (text.match(/\{\w+\}/g) || []).sort();
		for (const key of Object.keys(en)) {
			expect({ key, placeholders: placeholders(zhTW[key]) }).toEqual({ key, placeholders: placeholders(en[key]) });
		}
	});

	test("every text that app.js asks for exists", () => {
		const source = read("app.js");
		const keys = new Set([...source.matchAll(/\bt\("([\w.]+)"/g)].map((match) => match[1]));
		for (const kind of [...Object.keys(Wizard.KINDS), "other"]) keys.add(`kind.${kind}`);
		for (const step of ["kind", "connection", "pick", "interpret", "set", "options", "summary"])
			keys.add(`step.${step}`);
		for (const format of ["json", "xml", "text"]) keys.add(`format.${format}`);

		const missing = [...keys].filter((key) => en[key] === undefined);
		expect(missing).toEqual([]);
		expect(keys.size).toBeGreaterThan(100);
	});

	test("no text is left unused", () => {
		const source = read("app.js");
		const dynamic = /^(kind|step|format)\./;
		const unused = Object.keys(en).filter((key) => !dynamic.test(key) && !source.includes(`"${key}"`));
		expect(unused).toEqual([]);
	});

	test("chooses the language, Chinese as written in Taiwan or Hong Kong included", () => {
		expect(I18n.normalizeLanguage("zh-TW")).toBe("zh-TW");
		expect(I18n.normalizeLanguage("zh-tw")).toBe("zh-TW");
		expect(I18n.normalizeLanguage("zh-HK")).toBe("zh-TW");
		expect(I18n.normalizeLanguage("zh-Hant-TW")).toBe("zh-TW");
		expect(I18n.normalizeLanguage("en")).toBe("en");
		expect(I18n.normalizeLanguage("de")).toBe("en");
		expect(I18n.normalizeLanguage(undefined)).toBe("en");
	});

	test("fills in the placeholders and falls back to English and then to the key", () => {
		const t = I18n.createTranslator("en");
		expect(t("errorCount", { count: 3 })).toBe("3 error(s)");
		expect(t("setUrlHelp")).toContain("{value}");
		expect(t("no such text")).toBe("no such text");
		expect(I18n.createTranslator("zh-TW")("errorCount", { count: 3 })).toBe("3 個錯誤");
	});
});

describe("the files of the custom UI", () => {
	test("the page loads scripts that exist, in the order they need", () => {
		const html = read("index.html");
		const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((match) => match[1]);
		expect(scripts).toEqual(["i18n.js", "config-model.js", "wizard.js", "app.js"]);
		for (const script of scripts) expect(fs.existsSync(path.join(publicDir, script))).toBe(true);
		// The Homebridge UI adds these itself
		expect(html).not.toMatch(/<(html|head|body)\b/i);
	});

	test("the plugin tells Homebridge to use it, and keeps its form available", () => {
		const schema = buildSchema();
		expect(schema.customUi).toBe(true);
		// showSchemaForm() works only for a singular platform
		expect(schema.singular).toBe(true);
		expect(schema.pluginType).toBe("platform");
	});

	test("is published with the package", () => {
		const manifest = require("../package.json");
		expect(manifest.files).toContain("homebridge-ui/");
		expect(manifest.dependencies["@homebridge/plugin-ui-utils"]).toMatch(/^\d+\.\d+\.\d+$/);
	});
});

describe("the form of a single device", () => {
	const walk = (node, visit, where = "") => {
		if (!node || typeof node !== "object") return;
		visit(node, where);
		for (const [key, value] of Object.entries(node)) walk(value, visit, `${where}/${key}`);
	};
	const conditions = (schema) => {
		const found = [];
		walk(schema, (node) => {
			if (node.condition && node.condition.functionBody) found.push(node.condition.functionBody);
		});
		return found;
	};

	test("describes the same settings as a device of the platform form", () => {
		const platformDevice = buildSchema().schema.properties.devices.items;
		const { schema, layout, form } = buildDeviceFormSchema();
		expect(layout).toBeNull();
		expect(form).toBeNull();
		expect(Object.keys(schema.properties)).toEqual(Object.keys(platformDevice.properties));
	});

	test("its conditions look at the device itself and not at devices[...] of the platform", () => {
		const platformConditions = conditions(buildSchema().schema);
		const deviceConditions = conditions(buildDeviceFormSchema().schema);
		expect(deviceConditions).toHaveLength(platformConditions.length);
		expect(platformConditions.every((body) => body.includes("model.devices?.[arrayIndices[0]]"))).toBe(true);
		for (const body of deviceConditions) {
			expect(body).not.toMatch(/devices/);
			expect(body).toMatch(/model\?\.(characteristics|additionalServices)/);
		}
	});

	test("the indexes in its conditions are one fewer, since the device is the root", () => {
		const highest = (bodies) =>
			Math.max(...bodies.flatMap((body) => [...body.matchAll(/arrayIndices\[(\d)\]/g)].map((m) => Number(m[1]))));
		expect(highest(conditions(buildDeviceFormSchema().schema))).toBe(highest(conditions(buildSchema().schema)) - 1);
	});

	test("accepts what the validation of a device accepts", () => {
		const device = {
			name: "Lamp",
			service: "Switch",
			characteristics: [{ characteristic: "On", get: { url: "http://x" } }],
		};
		expect(validateDevice(device).errors).toEqual([]);
		expect(Object.keys(buildDeviceFormSchema().schema.properties)).toEqual(expect.arrayContaining(Object.keys(device)));
	});

	test("the defaults form has the settings that every device can inherit, open from the start", () => {
		const { schema } = buildDefaultsFormSchema();
		const platformDefaults = buildSchema().schema.properties.defaults;
		expect(Object.keys(schema.properties)).toEqual(Object.keys(platformDefaults.properties));
		expect(schema["x-schema-form"]).toBeUndefined();
		expect(platformDefaults["x-schema-form"]).toBeDefined();
	});
});
