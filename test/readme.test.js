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

	test("every device validates and loads", () => {
		for (const device of blocks.flatMap(devicesOf)) {
			expect({ name: device.name, errors: validateDevice(device).errors }).toEqual({ name: device.name, errors: [] });
			expect(() => normalizeDevice(device, { allowUnsafeEval: false })).not.toThrow();
		}
	});
});
