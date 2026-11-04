const fs = require("fs");
const path = require("path");
const { validateDevice, validatePlatform } = require("../src/validate.js");
const { normalizeDevice } = require("../src/device-config.js");

const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
const blocks = [...readme.matchAll(/```json\r?\n([\s\S]*?)```/g)].map((match) => JSON.parse(match[1]));

const devicesOf = (block) =>
	block.platforms ? block.platforms.flatMap((platform) => platform.devices || []) : block.service ? [block] : [];

describe("README examples", () => {
	test("has examples to check", () => {
		expect(blocks.length).toBeGreaterThan(5);
		expect(blocks.flatMap(devicesOf).length).toBeGreaterThan(5);
	});

	test("every platform block is valid", () => {
		for (const block of blocks) {
			for (const platform of block.platforms || []) {
				expect(validatePlatform(platform)).toEqual([]);
			}
		}
	});

	test("every characteristic in the README examples is one that the form offers", () => {
		const { CHARACTERISTICS } = require("../src/hap-names.js");
		const { OPTIONAL_CHARACTERISTICS } = require("../src/schema.js");
		const names = new Set();
		const options = new Set();
		for (const device of blocks.flatMap(devicesOf)) {
			const services = [device, ...(device.additionalServices || [])];
			for (const service of services) {
				(service.characteristics || []).forEach((entry) => names.add(entry.characteristic));
				(service.optionCharacteristic || []).forEach((name) => options.add(name));
			}
		}
		expect(names.size).toBeGreaterThan(5);
		expect(options.size).toBeGreaterThan(0);
		expect([...names, ...options].filter((name) => !CHARACTERISTICS.includes(name))).toEqual([]);
		// An optional characteristic is chosen among those that can be optional
		expect([...options].filter((name) => !OPTIONAL_CHARACTERISTICS.includes(name))).toEqual([]);
	});

	test("every service in the README examples is one that the form offers", () => {
		const { SERVICES } = require("../src/hap-names.js");
		const used = new Set();
		for (const device of blocks.flatMap(devicesOf)) {
			used.add(device.service);
			(device.additionalServices || []).forEach((extra) => used.add(extra.service));
		}
		expect(used.size).toBeGreaterThan(5);
		expect([...used].filter((name) => !SERVICES[name])).toEqual([]);
	});

	test("the list of supported services is the list that the form offers", () => {
		const { SERVICES } = require("../src/hap-names.js");
		const section = readme.split("## Supported services")[1].split("## Configuration Examples")[0];
		const listed = section
			.match(/```text\r?\n([\s\S]*?)```/)[1]
			.trim()
			.split(/\r?\n/);
		expect(listed).toEqual(Object.keys(SERVICES).sort((a, b) => a.localeCompare(b, "en")));
	});

	test("every device validates and loads", () => {
		for (const device of blocks.flatMap(devicesOf)) {
			expect({ name: device.name, errors: validateDevice(device).errors }).toEqual({ name: device.name, errors: [] });
			expect(() => normalizeDevice(device, { allowUnsafeEval: false })).not.toThrow();
		}
	});
});
