const Config = require("../homebridge-ui/public/config-model.js");

const lamp = (extra = {}) => ({ name: "Lamp", service: "Switch", characteristics: [], ...extra });
const platform = (devices, extra = {}) => ({
	platform: "HttpAdvancedPlatform",
	name: "HTTP Advanced",
	devices,
	...extra,
});
const names = (blocks) => Config.devicesOf(blocks).map((device) => device.name);

describe("reading the configuration", () => {
	test("finds the platform among other blocks", () => {
		const blocks = [{ platform: "Other" }, platform([lamp()])];
		expect(Config.findPlatform(blocks)).toBe(blocks[1]);
		expect(Config.devicesOf(blocks)).toHaveLength(1);
	});

	test("copes with a plugin that is not configured", () => {
		expect(Config.findPlatform([])).toBeUndefined();
		expect(Config.devicesOf([])).toEqual([]);
		expect(Config.devicesOf(undefined)).toEqual([]);
		expect(Config.defaultsOf([])).toEqual({});
		expect(Config.defaultsOf([platform([], { defaults: { timeout: 5 } })])).toEqual({ timeout: 5 });
	});
});

describe("changing the configuration", () => {
	test("never modifies what it is given", () => {
		const blocks = Object.freeze([Object.freeze(platform(Object.freeze([lamp()])))]);
		const snapshot = JSON.stringify(blocks);
		Config.addDevice(blocks, lamp({ name: "Fan" }));
		Config.removeDevice(blocks, 0);
		Config.duplicateDevice(blocks, 0);
		Config.moveDevice(blocks, 0, 1);
		Config.setDefaults(blocks, { timeout: 1 });
		Config.pinId(blocks, 0);
		expect(JSON.stringify(blocks)).toBe(snapshot);
	});

	test("creates the platform block when there is none, and keeps other blocks", () => {
		expect(Config.addDevice([], lamp())).toEqual([platform([lamp()])]);
		const other = { platform: "Other", name: "x" };
		expect(Config.addDevice([other], lamp())[0]).toEqual(other);
	});

	test("gives an added device a name and id that are free", () => {
		let blocks = Config.addDevice([], lamp());
		blocks = Config.addDevice(blocks, lamp());
		blocks = Config.addDevice(blocks, lamp());
		expect(names(blocks)).toEqual(["Lamp", "Lamp 2", "Lamp 3"]);

		blocks = Config.addDevice(blocks, lamp({ name: "Other", id: "x" }));
		blocks = Config.addDevice(blocks, lamp({ name: "Other 2", id: "x" }));
		expect(Config.devicesOf(blocks).map((device) => device.id)).toEqual([undefined, undefined, undefined, "x", "x 2"]);
	});

	test("an id that is the name of another device is not a clash that goes unnoticed", () => {
		const blocks = Config.addDevice([platform([lamp()])], lamp({ name: "Lamp 2", id: "Lamp" }));
		const devices = Config.devicesOf(blocks);
		const identifiers = devices.map((device) => device.id || device.name);
		expect(new Set(identifiers).size).toBe(2);
	});

	test("adds several devices at once", () => {
		const blocks = Config.addDevices([platform([lamp()])], [lamp(), lamp({ name: "Fan" })]);
		expect(names(blocks)).toEqual(["Lamp", "Lamp 2", "Fan"]);
	});

	test("replaces and removes a device by position", () => {
		const blocks = [platform([lamp(), lamp({ name: "Fan" })])];
		expect(names(Config.replaceDevice(blocks, 1, lamp({ name: "Pump" })))).toEqual(["Lamp", "Pump"]);
		expect(names(Config.removeDevice(blocks, 0))).toEqual(["Fan"]);
		expect(names(Config.removeDevice(blocks, 5))).toEqual(["Lamp", "Fan"]);
		expect(names(Config.replaceDevice(blocks, -1, lamp({ name: "X" })))).toEqual(["Lamp", "Fan"]);
	});

	test("moves a device up or down, and stops at the ends", () => {
		const blocks = [platform([lamp({ name: "A" }), lamp({ name: "B" }), lamp({ name: "C" })])];
		expect(names(Config.moveDevice(blocks, 1, -1))).toEqual(["B", "A", "C"]);
		expect(names(Config.moveDevice(blocks, 1, 1))).toEqual(["A", "C", "B"]);
		expect(names(Config.moveDevice(blocks, 0, -1))).toEqual(["A", "B", "C"]);
		expect(names(Config.moveDevice(blocks, 2, 1))).toEqual(["A", "B", "C"]);
	});

	test("duplicates a device right below the original, with its own name and id", () => {
		const blocks = [platform([lamp({ id: "lamp" }), lamp({ name: "Fan" })])];
		const copied = Config.devicesOf(Config.duplicateDevice(blocks, 0));
		expect(copied.map((device) => device.name)).toEqual(["Lamp", "Lamp copy", "Fan"]);
		expect(copied[1].id).toBe("lamp copy");

		const twice = Config.duplicateDevice(Config.duplicateDevice(blocks, 0), 0);
		expect(names(twice)).toEqual(["Lamp", "Lamp copy 2", "Lamp copy", "Fan"]);
	});

	test("a copy is independent of the original", () => {
		const original = lamp({ characteristics: [{ characteristic: "On" }] });
		const blocks = Config.duplicateDevice([platform([original])], 0);
		Config.devicesOf(blocks)[1].characteristics[0].characteristic = "Changed";
		expect(Config.devicesOf(blocks)[0].characteristics[0].characteristic).toBe("On");
	});

	test("sets and clears the defaults", () => {
		const blocks = Config.setDefaults([platform([])], { timeout: 5 });
		expect(Config.defaultsOf(blocks)).toEqual({ timeout: 5 });
		expect(Config.findPlatform(Config.setDefaults(blocks, {}))).not.toHaveProperty("defaults");
	});

	test("pins an id equal to the name, unless the device has one", () => {
		const blocks = [platform([lamp(), lamp({ name: "Fan", id: "fan-1" })])];
		expect(Config.devicesOf(Config.pinId(blocks, 0))[0].id).toBe("Lamp");
		expect(Config.devicesOf(Config.pinId(blocks, 1))[1].id).toBe("fan-1");
	});
});

describe("describing a device", () => {
	const air = {
		name: "Air",
		id: "air",
		service: "CarbonDioxideSensor",
		characteristics: [
			{ characteristic: "CarbonDioxideLevel", get: { url: "http://x" } },
			{ characteristic: "Active", get: { url: "http://x" }, set: { url: "http://x?v={value}" } },
			{ characteristic: "Nothing" },
		],
		additionalServices: [
			{
				id: "battery",
				service: "BatteryService",
				characteristics: [{ characteristic: "BatteryLevel", get: { url: "http://x" } }],
			},
		],
	};

	test("summarizes it for the list", () => {
		expect(Config.summarize(air)).toEqual({
			name: "Air",
			id: "air",
			service: "CarbonDioxideSensor",
			characteristics: 4,
			additionalServices: 1,
		});
		expect(Config.summarize({})).toEqual({ name: "", id: "", service: "", characteristics: 0, additionalServices: 0 });
	});

	test("lists what can be tested, including additional services", () => {
		expect(Config.actionsOf(air)).toEqual([
			{ service: "", characteristic: "CarbonDioxideLevel", get: true, set: false },
			{ service: "", characteristic: "Active", get: true, set: true },
			{ service: "", characteristic: "Nothing", get: false, set: false },
			{ service: "battery", characteristic: "BatteryLevel", get: true, set: false },
		]);
		expect(Config.actionsOf({})).toEqual([]);
	});
});

describe("exportDevice", () => {
	const device = {
		name: "Lamp",
		service: "Switch",
		bearerToken: "secret",
		password: "hunter2",
		headers: [
			{ name: "X-Api-Key", value: "key-1" },
			{ name: "X-From-Env", value: "env:MY_KEY" },
		],
		characteristics: [{ characteristic: "On", get: { url: "http://x", bearerToken: "file:/run/token" } }],
	};

	test("hides passwords, tokens and header values, and keeps references", () => {
		const exported = JSON.parse(Config.exportDevice(device));
		expect(exported.bearerToken).toBe("***");
		expect(exported.password).toBe("***");
		expect(exported.headers).toEqual([
			{ name: "X-Api-Key", value: "***" },
			{ name: "X-From-Env", value: "env:MY_KEY" },
		]);
		expect(exported.characteristics[0].get.bearerToken).toBe("file:/run/token");
		expect(Config.exportDevice(device)).not.toMatch(/secret|hunter2|key-1/);
	});

	test("leaves everything else as it is, and the device untouched", () => {
		const exported = JSON.parse(Config.exportDevice(device));
		expect(exported).toMatchObject({ name: "Lamp", service: "Switch" });
		expect(exported.characteristics[0].get.url).toBe("http://x");
		expect(device.bearerToken).toBe("secret");
	});

	test("does not add a mask to an empty value", () => {
		expect(JSON.parse(Config.exportDevice({ name: "x", password: "" })).password).toBe("");
	});
});
