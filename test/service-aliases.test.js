const { SERVICE_ALIASES, currentServiceName, findService } = require("../src/service-aliases.js");

describe("service names", () => {
	test("an old name becomes the new one, any other name stays", () => {
		expect(currentServiceName("BatteryService")).toBe("Battery");
		expect(currentServiceName("Relay")).toBe("CloudRelay");
		expect(currentServiceName("Battery")).toBe("Battery");
		expect(currentServiceName("Switch")).toBe("Switch");
		expect(currentServiceName("constructor")).toBe("constructor");
		expect(currentServiceName(undefined)).toBeUndefined();
	});

	test("finds a service by the name that the configuration has, in any HAP-NodeJS", () => {
		class Battery {}
		class OldBattery {}
		class Switch {}

		// A HAP-NodeJS that has only the new names (Homebridge 2.x), and one that has only the old ones
		expect(findService({ Battery, Switch }, "BatteryService")).toBe(Battery);
		expect(findService({ Battery, Switch }, "Battery")).toBe(Battery);
		expect(findService({ BatteryService: OldBattery, Switch }, "Battery")).toBe(OldBattery);
		expect(findService({ BatteryService: OldBattery, Battery }, "BatteryService")).toBe(OldBattery);
		expect(findService({ Switch }, "Switch")).toBe(Switch);
	});

	test("does not find what is not a service", () => {
		expect(findService({ Switch: class {} }, "Nothing")).toBeUndefined();
		expect(findService({ Switch: class {} }, "constructor")).toBeUndefined();
		expect(findService({ UUID: "x" }, "UUID")).toBeUndefined();
		expect(findService({}, undefined)).toBeUndefined();
	});

	test("every old name points to a name that the form offers", () => {
		const { SERVICES } = require("../src/hap-names.js");
		for (const [from, to] of Object.entries(SERVICE_ALIASES)) {
			expect({ from, to, offered: Object.keys(SERVICES).includes(to) }).toEqual({ from, to, offered: true });
			expect(Object.keys(SERVICES)).not.toContain(from);
		}
	});
});
