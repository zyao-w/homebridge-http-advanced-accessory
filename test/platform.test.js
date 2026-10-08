const HttpAdvancedPlatform = require("../src/platform.js");

class FakeCharacteristic {
	constructor(displayName, format = "string") {
		this.displayName = displayName;
		this.props = { format };
		this.value = null;
		this.setProps = jest.fn((props) => Object.assign(this.props, props));
		this.updateValue = jest.fn((value) => {
			this.value = value;
		});
	}
	onGet(handler) {
		this.getHandler = handler;
		return this;
	}
	onSet(handler) {
		this.setHandler = handler;
		return this;
	}
}

class FakeService {
	constructor(name) {
		this.displayName = name;
		this.UUID = this.constructor.UUID;
		this.characteristics = [];
		this.optionalCharacteristics = [];
	}
	addCharacteristic(characteristic) {
		if (!this.characteristics.includes(characteristic)) this.characteristics.push(characteristic);
		return characteristic;
	}
	setCharacteristic() {
		return this;
	}
}

class InformationService extends FakeService {
	static UUID = "information";
	constructor(name) {
		super(name);
		this.values = {};
	}
	setCharacteristic(characteristic, value) {
		this.values[characteristic] = value;
		return this;
	}
}

class SwitchService extends FakeService {
	static UUID = "switch";
	constructor(name) {
		super(name);
		this.characteristics = [new FakeCharacteristic("On", "bool"), new FakeCharacteristic("Name")];
	}
}

class LightService extends FakeService {
	static UUID = "light";
	constructor(name) {
		super(name);
		this.characteristics = [new FakeCharacteristic("On", "bool")];
		this.optionalCharacteristics = [
			new FakeCharacteristic("Brightness", "int"),
			new FakeCharacteristic("PM2.5 Density", "float"),
		];
	}
}

class HumidityService extends FakeService {
	static UUID = "humidity";
	constructor(name) {
		super(name);
		this.characteristics = [new FakeCharacteristic("Current Relative Humidity", "float")];
	}
}

class BatteryService extends FakeService {
	static UUID = "battery";
	constructor(name) {
		super(name);
		this.characteristics = [new FakeCharacteristic("Status Low Battery", "int")];
		this.optionalCharacteristics = [new FakeCharacteristic("Battery Level", "int")];
	}
}

class FakeAccessory {
	constructor(displayName, UUID) {
		this.displayName = displayName;
		this.UUID = UUID;
		this.services = [];
	}
	getService(Type) {
		return this.services.find((service) => service instanceof Type);
	}
	addService(Type, name, subtype) {
		const service = new Type(name);
		service.subtype = subtype;
		this.services.push(service);
		return service;
	}
	removeService(service) {
		this.services = this.services.filter((existing) => existing !== service);
	}
}

class HapStatusError extends Error {
	constructor(status) {
		super("HAP status " + status);
		this.status = status;
	}
}

function makeApi() {
	const listeners = {};
	return {
		hap: {
			Service: {
				AccessoryInformation: InformationService,
				Switch: SwitchService,
				Lightbulb: LightService,
				HumiditySensor: HumidityService,
				BatteryService,
			},
			Characteristic: { Manufacturer: "m", Model: "mo", SerialNumber: "s" },
			uuid: { generate: (seed) => "uuid:" + seed },
			HapStatusError,
			HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 },
		},
		platformAccessory: FakeAccessory,
		on: (event, handler) => {
			listeners[event] = handler;
		},
		emit: (event) => listeners[event](),
		registerPlatformAccessories: jest.fn(),
		updatePlatformAccessories: jest.fn(),
		unregisterPlatformAccessories: jest.fn(),
	};
}

const fetchMock = jest.fn();
const originalFetch = global.fetch;
let responses;

beforeEach(() => {
	responses = {};
	fetchMock.mockReset();
	fetchMock.mockImplementation(async (url) => {
		const response = responses[url];
		if (response instanceof Error) throw response;
		if (response && typeof response === "object") {
			return { status: response.status, text: async () => response.body || "" };
		}
		return { status: 200, text: async () => (response === undefined ? "" : response) };
	});
	global.fetch = fetchMock;
});

afterEach(() => {
	global.fetch = originalFetch;
	jest.useRealTimers();
});

function launch(config, { cached = [] } = {}) {
	const api = makeApi();
	const log = Object.assign(jest.fn(), { error: jest.fn() });
	const platform = new HttpAdvancedPlatform(log, { platform: "HttpAdvancedPlatform", ...config }, api);
	cached.forEach((accessory) => platform.configureAccessory(accessory));
	api.emit("didFinishLaunching");
	return { api, log, platform };
}

const registered = (api) => (api.registerPlatformAccessories.mock.calls[0] || [])[2] || [];
const serviceOf = (accessory, UUID = "switch") => accessory.services.find((service) => service.UUID === UUID);
const urlOf = (call) => fetchMock.mock.calls[call][0];
const initOf = (call) => fetchMock.mock.calls[call][1];

const switchDevice = (extra = {}) => ({
	name: "Pump",
	service: "Switch",
	characteristics: [
		{
			characteristic: "On",
			get: { url: "http://h/status", mappers: [{ type: "static", mapping: [{ from: "RUN", to: "1" }] }] },
			set: { url: "http://h/set?v={value}", mappers: [{ type: "static", mapping: [{ from: "1", to: "on" }] }] },
		},
	],
	...extra,
});

describe("registering accessories", () => {
	test("registers a new accessory per device with a UUID derived from the name", () => {
		const { api, log } = launch({ devices: [switchDevice(), { name: "Fan", service: "Switch" }] });
		const [call] = api.registerPlatformAccessories.mock.calls;
		expect(call.slice(0, 2)).toEqual(["homebridge-http-advanced-accessory-zyao", "HttpAdvancedPlatform"]);
		expect(call[2].map((a) => [a.displayName, a.UUID])).toEqual([
			["Pump", "uuid:HttpAdvancedPlatform:Pump"],
			["Fan", "uuid:HttpAdvancedPlatform:Fan"],
		]);
		expect(api.updatePlatformAccessories).not.toHaveBeenCalled();
		expect(api.unregisterPlatformAccessories).not.toHaveBeenCalled();
		expect(log.error).not.toHaveBeenCalled();
	});

	test("an explicit id keeps the UUID when the device is renamed", () => {
		const { api } = launch({ devices: [{ name: "Renamed pump", id: "pump-1", service: "Switch" }] });
		expect(registered(api)[0].UUID).toBe("uuid:HttpAdvancedPlatform:pump-1");
	});

	test("restores a cached accessory instead of registering it again", () => {
		const cached = new FakeAccessory("Pump", "uuid:HttpAdvancedPlatform:Pump");
		cached.addService(SwitchService, "Old");
		cached.addService(LightService, "Leftover");
		const oldSwitch = serviceOf(cached);

		const { api } = launch({ devices: [switchDevice()] }, { cached: [cached] });

		expect(api.registerPlatformAccessories).not.toHaveBeenCalled();
		expect(api.updatePlatformAccessories).toHaveBeenCalledWith([cached]);
		// The services are rebuilt from the configuration
		expect(cached.services.map((s) => s.UUID).sort()).toEqual(["information", "switch"]);
		expect(serviceOf(cached)).not.toBe(oldSwitch);
		expect(serviceOf(cached).characteristics[0].getHandler).toBeInstanceOf(Function);
	});

	test("unregisters cached accessories of devices that are no longer configured", () => {
		const stale = new FakeAccessory("Gone", "uuid:HttpAdvancedPlatform:Gone");
		const { api } = launch({ devices: [switchDevice()] }, { cached: [stale] });
		expect(api.unregisterPlatformAccessories).toHaveBeenCalledWith(
			"homebridge-http-advanced-accessory-zyao",
			"HttpAdvancedPlatform",
			[stale]
		);
	});

	test("a device that fails to load keeps its cached accessory", () => {
		const cached = new FakeAccessory("Pump", "uuid:HttpAdvancedPlatform:Pump");
		const { api, log } = launch(
			{ devices: [{ name: "Pump", service: "Switch", forceRefreshDelays: 5 }] },
			{ cached: [cached] }
		);
		expect(api.unregisterPlatformAccessories).not.toHaveBeenCalled();
		expect(log.error).toHaveBeenCalledWith('Device "Pump": has an unknown setting "forceRefreshDelays"');
	});

	test("reports devices that cannot be loaded and continues with the others", () => {
		const { api, log } = launch({
			devices: [
				{ service: "Switch" },
				{ name: "NoService", service: "Nope" },
				{ name: "NoUrl", service: "Switch", characteristics: [{ characteristic: "On", get: {} }] },
				{ name: "Twice", service: "Switch", characteristics: [{ characteristic: "On" }, { characteristic: "On" }] },
				{ name: "Good", service: "Switch" },
			],
		});
		expect(registered(api).map((a) => a.displayName)).toEqual(["Good"]);
		expect(log.error).toHaveBeenCalledTimes(4);
		expect(log.error.mock.calls.map(([message]) => message).join("\n")).toMatch(/unknown service "Nope"/);
		expect(log.error.mock.calls.map(([message]) => message).join("\n")).toMatch(/On get has no url/);
		expect(log.error.mock.calls.map(([message]) => message).join("\n")).toMatch(/"On" is listed twice/);
	});

	test("rejects two devices with the same identifier", () => {
		const { api, log } = launch({
			devices: [
				{ name: "A", id: "same", service: "Switch" },
				{ name: "B", id: "same", service: "Switch" },
			],
		});
		expect(registered(api).map((a) => a.displayName)).toEqual(["A"]);
		expect(log.error).toHaveBeenCalledWith(expect.stringContaining("same identifier"));
	});

	test("reports unknown platform settings", () => {
		const { log } = launch({ devises: [] });
		expect(log.error).toHaveBeenCalledWith('Platform configuration: has an unknown setting "devises"');
	});

	test("requires allowUnsafeEval for script mappers", () => {
		const device = {
			name: "Scripted",
			service: "Switch",
			characteristics: [{ characteristic: "On", get: { url: "u", mappers: [{ type: "script", script: "value" }] } }],
		};
		const refused = launch({ devices: [device] });
		expect(registered(refused.api)).toEqual([]);
		expect(refused.log.error).toHaveBeenCalledWith(expect.stringContaining('"allowUnsafeEval": true'));

		const allowed = launch({ devices: [{ ...device, allowUnsafeEval: true }] });
		expect(registered(allowed.api)).toHaveLength(1);

		const fromDefaults = launch({ defaults: { allowUnsafeEval: true }, devices: [device] });
		expect(registered(fromDefaults.api)).toHaveLength(1);
	});
});

describe("accessory information", () => {
	// The fake HAP names its characteristics m (Manufacturer), mo (Model) and s (SerialNumber)
	const informationOf = (config) => {
		const { api } = launch(config);
		return registered(api)[0].getService(InformationService).values;
	};

	test("keeps the generic values when nothing is configured", () => {
		expect(informationOf({ devices: [switchDevice()] })).toEqual({
			m: "Custom Manufacturer",
			mo: "HTTP Accessory Model",
			s: "HTTP Accessory Serial Number",
		});
	});

	test("uses the device settings over the platform defaults", () => {
		const device = switchDevice({ model: "Pump 3000", serialNumber: "SN-42" });
		expect(informationOf({ defaults: { manufacturer: "Acme", model: "Generic" }, devices: [device] })).toEqual({
			m: "Acme",
			mo: "Pump 3000",
			s: "SN-42",
		});
	});

	test("does not change the identity of the accessory", () => {
		const plain = registered(launch({ devices: [switchDevice()] }).api)[0].UUID;
		const described = registered(launch({ devices: [switchDevice({ serialNumber: "SN-42" })] }).api)[0].UUID;
		expect(described).toBe(plain);
	});
});

describe("characteristics", () => {
	test("binds the optional characteristics that are listed and warns about unknown ones", () => {
		const { api, log } = launch({
			devices: [
				{
					name: "Lamp",
					service: "Lightbulb",
					optionCharacteristic: ["Brightness"],
					characteristics: [
						{ characteristic: "On" },
						{ characteristic: "Brightness", props: { minValue: 10 } },
						{ characteristic: "Hue" },
					],
				},
			],
		});
		const service = serviceOf(registered(api)[0], "light");
		expect(service.characteristics.map((c) => c.displayName)).toEqual(["On", "Brightness"]);
		expect(service.characteristics[1].setProps).toHaveBeenCalledWith({ minValue: 10 });
		expect(service.characteristics[0].setProps).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledWith(expect.stringContaining('no characteristic "Hue"'));
	});

	test("matches characteristics by display name without spaces", () => {
		const { api } = launch({
			devices: [
				{
					name: "Air",
					service: "Lightbulb",
					optionCharacteristic: ["PM2.5Density"],
					characteristics: [{ characteristic: "PM2.5Density", get: { url: "http://h/air" } }],
				},
			],
		});
		expect(serviceOf(registered(api)[0], "light").characteristics.map((c) => c.displayName)).toContain("PM2.5 Density");
	});
});

describe("reading", () => {
	const characteristicOf = (api) => serviceOf(registered(api)[0]).characteristics[0];

	test("answers a get with the mapped value and updates the characteristic", async () => {
		responses["http://h/status"] = "RUN";
		const { api } = launch({ devices: [switchDevice()] });
		const characteristic = characteristicOf(api);
		expect(await characteristic.getHandler()).toBe("1");
		expect(characteristic.updateValue).toHaveBeenCalledWith("1");
	});

	test("fails a get with a communication error and logs the reason", async () => {
		responses["http://h/status"] = new Error("ECONNREFUSED");
		const { api, log } = launch({ devices: [switchDevice()] });
		await expect(characteristicOf(api).getHandler()).rejects.toMatchObject({ status: -70402 });
		expect(log).toHaveBeenCalledWith("[Pump] GetState function failed: %s", "ECONNREFUSED");
	});

	test("fails a get with a communication error when the server answers outside 2xx", async () => {
		responses["http://h/status"] = { status: 401, body: '{"detail":"Not authenticated"}' };
		const { api, log } = launch({ devices: [switchDevice()] });
		await expect(characteristicOf(api).getHandler()).rejects.toMatchObject({ status: -70402 });
		expect(log).toHaveBeenCalledWith("[Pump] GetState function failed: %s", "HTTP 401 Unauthorized");
	});

	test("resultOnError also covers an answer outside 2xx", async () => {
		responses["http://h/status"] = { status: 503, body: "" };
		const device = switchDevice();
		device.characteristics[0].get.resultOnError = "0";
		const { api } = launch({ devices: [device] });
		expect(await characteristicOf(api).getHandler()).toBe("0");
	});

	test("uses resultOnError instead of failing", async () => {
		responses["http://h/status"] = new Error("down");
		const device = switchDevice();
		device.characteristics[0].get.resultOnError = "0";
		const { api } = launch({ devices: [device] });
		expect(await characteristicOf(api).getHandler()).toBe("0");
	});

	test("follows the inconclusive fallback action", async () => {
		responses["http://h/a"] = "MAYBE";
		responses["http://h/b"] = "RUN";
		const { api } = launch({
			devices: [
				{
					name: "Pump",
					service: "Switch",
					characteristics: [
						{
							characteristic: "On",
							get: {
								url: "http://h/a",
								mappers: [{ type: "static", mapping: [{ from: "MAYBE", to: "inconclusive" }] }],
								inconclusive: { url: "http://h/b", mappers: [{ type: "static", mapping: [{ from: "RUN", to: "1" }] }] },
							},
						},
					],
				},
			],
		});
		expect(await characteristicOf(api).getHandler()).toBe("1");
	});

	test("answers the Name characteristic with the device name", async () => {
		const { api } = launch({ devices: [switchDevice()] });
		const name = serviceOf(registered(api)[0]).characteristics[1];
		expect(name.displayName).toBe("Name");
		expect(await name.getHandler()).toBe("Pump");
	});

	test("a characteristic without a get action answers with its current value", async () => {
		const { api } = launch({ devices: [{ name: "Pump", service: "Switch" }] });
		const characteristic = characteristicOf(api);
		characteristic.value = true;
		expect(await characteristic.getHandler()).toBe(true);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("simultaneous gets of the same request issue one HTTP request", async () => {
		responses["http://h/status"] = "5";
		const { api } = launch({
			devices: [
				{
					name: "Lamp",
					service: "Lightbulb",
					optionCharacteristic: ["Brightness"],
					characteristics: [
						{ characteristic: "On", get: { url: "http://h/status" } },
						{ characteristic: "Brightness", get: { url: "http://h/status" } },
					],
				},
			],
		});
		await Promise.all(serviceOf(registered(api)[0], "light").characteristics.map((c) => c.getHandler()));
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("writing", () => {
	const characteristicOf = (api) => serviceOf(registered(api)[0]).characteristics[0];

	test("sends the mapped value", async () => {
		const { api } = launch({ devices: [switchDevice()] });
		await characteristicOf(api).setHandler("1");
		expect(urlOf(0)).toBe("http://h/set?v=on");
	});

	test("scales the value of a set and fails before sending when it is not a number", async () => {
		const scale = { type: "scale", inputMin: 0, inputMax: 100, outputMin: 0, outputMax: 255, round: 0 };
		const device = switchDevice({
			characteristics: [{ characteristic: "On", set: { url: "http://h/level/{value}", mappers: [scale] } }],
		});
		const { api, log } = launch({ devices: [device] });
		const characteristic = characteristicOf(api);

		await characteristic.setHandler(50);
		expect(urlOf(0)).toBe("http://h/level/128");

		fetchMock.mockClear();
		await expect(characteristic.setHandler("abc")).rejects.toMatchObject({ status: -70402 });
		expect(fetchMock).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledWith(
			"[Pump] SetState function failed: %s",
			"The mappers could not convert the value abc, nothing was sent"
		);
	});

	test("scales a polled value and treats a non-number as an error", async () => {
		jest.useFakeTimers();
		responses["http://h/level"] = "255";
		const scale = { type: "scale", inputMin: 0, inputMax: 255, outputMin: 0, outputMax: 100 };
		const device = switchDevice({
			forceRefreshDelay: 5,
			characteristics: [{ characteristic: "On", get: { url: "http://h/level", mappers: [scale] } }],
		});
		const { api } = launch({ devices: [device] });
		const characteristic = characteristicOf(api);
		await jest.advanceTimersByTimeAsync(0);
		expect(await characteristic.getHandler()).toBe(100);

		responses["http://h/level"] = "offline";
		await jest.advanceTimersByTimeAsync(5000);
		await expect(characteristic.getHandler()).rejects.toMatchObject({ status: -70402 });
	});

	test("templates see the value and the state keyed by characteristic name", async () => {
		const { api } = launch({
			devices: [
				{
					name: "Lamp",
					service: "Lightbulb",
					characteristics: [
						{
							characteristic: "On",
							set: {
								url: "http://h/p?x=${state.On}&v={value}",
								httpMethod: "POST",
								body: "n=${value == 1 ? 'a' : 'b'}",
							},
						},
					],
				},
			],
		});
		const service = serviceOf(registered(api)[0], "light");
		await service.characteristics[0].setHandler(1);
		expect(urlOf(0)).toBe("http://h/p?x=undefined&v=1");
		expect(initOf(0).method).toBe("POST");
		expect(Buffer.from(initOf(0).body).toString()).toBe("n=a");

		// A successful set becomes part of the state seen by later templates
		await service.characteristics[0].setHandler(0);
		expect(urlOf(1)).toBe("http://h/p?x=1&v=0");
	});

	test("fails a set with a communication error when the server answers outside 2xx", async () => {
		responses["http://h/set?v=on"] = { status: 500, body: "" };
		const { api, log } = launch({ devices: [switchDevice()] });
		await expect(characteristicOf(api).setHandler("1")).rejects.toMatchObject({ status: -70402 });
		expect(log).toHaveBeenCalledWith("[Pump] SetState function failed: %s", "HTTP 500 Internal Server Error");
	});

	test("fails a set with a communication error", async () => {
		responses["http://h/set?v=on"] = new Error("ECONNREFUSED");
		const { api, log } = launch({ devices: [switchDevice()] });
		await expect(characteristicOf(api).setHandler("1")).rejects.toMatchObject({ status: -70402 });
		expect(log).toHaveBeenCalledWith("[Pump] SetState function failed: %s", "ECONNREFUSED");
	});

	test("refuses a template the expression language does not offer unless allowUnsafeEval is set", () => {
		const device = {
			name: "Pump",
			service: "Switch",
			characteristics: [{ characteristic: "On", set: { url: "http://h/${[1].map(n => n)}" } }],
		};
		const refused = launch({ devices: [device] });
		expect(registered(refused.api)).toEqual([]);
		expect(refused.log.error).toHaveBeenCalledWith(expect.stringContaining('"allowUnsafeEval": true'));

		expect(registered(launch({ devices: [{ ...device, allowUnsafeEval: true }] }).api)).toHaveLength(1);
	});

	test("reports a template that fails when it runs as a communication error without sending a request", async () => {
		const { api } = launch({
			devices: [
				{
					name: "Pump",
					service: "Switch",
					allowUnsafeEval: true,
					characteristics: [{ characteristic: "On", set: { url: "http://h/${missing.prop}" } }],
				},
			],
		});
		await expect(characteristicOf(api).setHandler(1)).rejects.toMatchObject({ status: -70402 });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("a characteristic without a set action accepts the value", async () => {
		const { api } = launch({ devices: [{ name: "Pump", service: "Switch" }] });
		await expect(characteristicOf(api).setHandler(1)).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("setterDelay answers at once and sends only the last value", async () => {
		jest.useFakeTimers();
		const { api } = launch({ devices: [switchDevice({ setterDelay: 1000 })] });
		const characteristic = characteristicOf(api);
		await characteristic.setHandler("0");
		await characteristic.setHandler("1");
		expect(fetchMock).not.toHaveBeenCalled();
		await jest.advanceTimersByTimeAsync(1000);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(urlOf(0)).toBe("http://h/set?v=on");
	});
});

describe("additional services", () => {
	const sensor = (extra = {}) => ({
		name: "Air",
		service: "Switch",
		forceRefreshDelay: 5,
		characteristics: [{ characteristic: "On", get: { url: "http://h/air" } }],
		additionalServices: [
			{
				id: "humidity",
				service: "HumiditySensor",
				characteristics: [
					{
						characteristic: "CurrentRelativeHumidity",
						get: { url: "http://h/air", mappers: [{ type: "jpath", jpath: "$.rh" }] },
					},
				],
			},
			{
				id: "battery",
				name: "Battery",
				service: "BatteryService",
				optionCharacteristic: ["BatteryLevel"],
				characteristics: [
					{ characteristic: "StatusLowBattery", get: { url: "http://h/battery/low" } },
					{ characteristic: "BatteryLevel", get: { url: "http://h/battery/level" } },
				],
			},
		],
		...extra,
	});
	const characteristicsOf = (accessory, UUID) => serviceOf(accessory, UUID).characteristics;
	const named = (accessory, UUID, name) =>
		serviceOf(accessory, UUID).characteristics.find((c) => c.displayName === name);

	test("adds the services to the accessory in order, each with its own identifier", () => {
		const { api } = launch({ devices: [sensor()] });
		const [accessory] = registered(api);
		expect(accessory.services.map((s) => [s.UUID, s.subtype, s.displayName])).toEqual([
			["information", undefined, undefined],
			["switch", undefined, "Air"],
			["humidity", "humidity", "Air humidity"],
			["battery", "battery", "Battery"],
		]);
	});

	test("reads every service and shares one request between services that use the same URL", async () => {
		jest.useFakeTimers();
		responses["http://h/air"] = '{"rh":55.5}';
		responses["http://h/battery/low"] = "0";
		responses["http://h/battery/level"] = "87";
		const { api } = launch({ devices: [sensor()] });
		const [accessory] = registered(api);
		await jest.advanceTimersByTimeAsync(0);

		expect(fetchMock.mock.calls.map((call) => call[0]).sort()).toEqual([
			"http://h/air",
			"http://h/battery/level",
			"http://h/battery/low",
		]);
		expect(await named(accessory, "humidity", "Current Relative Humidity").getHandler()).toBe(55.5);
		expect(await named(accessory, "battery", "Status Low Battery").getHandler()).toBe(0);
		expect(await named(accessory, "battery", "Battery Level").getHandler()).toBe(87);
	});

	test("templates reach the values of an additional service as state.<id>.<characteristic>", async () => {
		jest.useFakeTimers();
		responses["http://h/air"] = "{}";
		responses["http://h/battery/level"] = "87";
		const device = sensor();
		device.characteristics[0].set = { url: "http://h/set?battery=${state.battery.BatteryLevel}&v={value}" };
		const { api } = launch({ devices: [device] });
		const [accessory] = registered(api);
		await jest.advanceTimersByTimeAsync(0);

		await characteristicsOf(accessory, "switch")[0].setHandler(1);
		expect(fetchMock.mock.calls.map((call) => call[0])).toContain("http://h/set?battery=87&v=1");
	});

	test("two services can use the same characteristic name without sharing values or failures", async () => {
		jest.useFakeTimers();
		responses["http://h/a"] = "11";
		responses["http://h/b"] = { status: 503, body: "" };
		const battery = (id, url) => ({
			id,
			service: "BatteryService",
			optionCharacteristic: ["BatteryLevel"],
			characteristics: [{ characteristic: "BatteryLevel", get: { url } }],
		});
		const device = {
			name: "Pair",
			service: "Switch",
			forceRefreshDelay: 5,
			additionalServices: [battery("a", "http://h/a"), battery("b", "http://h/b")],
		};
		const { api, log } = launch({ devices: [device] });
		const [accessory] = registered(api);
		await jest.advanceTimersByTimeAsync(0);

		const [first, second] = accessory.services.filter((s) => s.UUID === "battery");
		const level = (service) => service.characteristics.find((c) => c.displayName === "Battery Level");
		expect(await level(first).getHandler()).toBe(11);
		await expect(level(second).getHandler()).rejects.toMatchObject({ status: -70402 });
		expect(log).toHaveBeenCalledWith(
			"[Pair] Poller for %s errored: %s",
			"b.BatteryLevel",
			"HTTP 503 Service Unavailable"
		);
		expect(log).not.toHaveBeenCalledWith("[Pair] Poller for %s errored: %s", "a.BatteryLevel", expect.anything());
	});

	test("a failed read in an additional service does not touch the others", async () => {
		jest.useFakeTimers();
		responses["http://h/air"] = '{"rh":40}';
		responses["http://h/battery/low"] = { status: 401, body: "" };
		responses["http://h/battery/level"] = "50";
		const { api } = launch({ devices: [sensor()] });
		const [accessory] = registered(api);
		await jest.advanceTimersByTimeAsync(0);

		await expect(named(accessory, "battery", "Status Low Battery").getHandler()).rejects.toMatchObject({
			status: -70402,
		});
		expect(await named(accessory, "battery", "Battery Level").getHandler()).toBe(50);
		expect(await named(accessory, "humidity", "Current Relative Humidity").getHandler()).toBe(40);
	});

	test("reads without polling answer from the request of the service", async () => {
		responses["http://h/air"] = '{"rh":61}';
		const device = sensor({ forceRefreshDelay: 0 });
		const { api } = launch({ devices: [device] });
		const [accessory] = registered(api);
		expect(await named(accessory, "humidity", "Current Relative Humidity").getHandler()).toBe(61);
	});

	test("rebuilds the services of a cached accessory, including the additional ones", () => {
		const cached = new FakeAccessory("Air", "uuid:HttpAdvancedPlatform:Air");
		cached.addService(SwitchService, "Old");
		cached.addService(BatteryService, "Leftover", "gone");

		const { api } = launch({ devices: [sensor()] }, { cached: [cached] });
		expect(api.updatePlatformAccessories).toHaveBeenCalledWith([cached]);
		expect(cached.services.map((s) => [s.UUID, s.subtype])).toEqual([
			["information", undefined],
			["switch", undefined],
			["humidity", "humidity"],
			["battery", "battery"],
		]);
	});

	test("a cached accessory keeps its services when an additional service is unknown", () => {
		const cached = new FakeAccessory("Air", "uuid:HttpAdvancedPlatform:Air");
		cached.addService(SwitchService, "Old");
		const before = [...cached.services];

		const device = sensor();
		device.additionalServices[0].service = "Nope";
		const { api, log } = launch({ devices: [device] }, { cached: [cached] });

		expect(log.error).toHaveBeenCalledWith('Device "Air" service "humidity" has an unknown service "Nope"');
		expect(api.updatePlatformAccessories).not.toHaveBeenCalled();
		expect(cached.services).toEqual(before);
	});

	test.each([
		["has no id", { id: undefined }, /additional service 1 has no "id"/],
		["has no service", { service: undefined }, /service "humidity" has no "service"/],
		["clashes with a characteristic", { id: "On" }, /the id clashes with a characteristic of the device/],
		["is the prototype", { id: "__proto__" }, /the id clashes/],
	])("refuses a service that %s and keeps the other devices", (_, change, message) => {
		const device = sensor();
		device.additionalServices[0] = { ...device.additionalServices[0], ...change };
		const { api, log } = launch({ devices: [device, switchDevice()] });
		expect(registered(api).map((a) => a.displayName)).toEqual(["Pump"]);
		expect(log.error).toHaveBeenCalledWith(expect.stringMatching(message));
	});

	test("refuses two services with the same id", () => {
		const device = sensor();
		device.additionalServices[1].id = "humidity";
		const { api, log } = launch({ devices: [device] });
		expect(registered(api)).toEqual([]);
		expect(log.error).toHaveBeenCalledWith('Device "Air": the service id "humidity" is used twice');
	});

	test("ignores the empty row that the form shows for an empty list", () => {
		const { api } = launch({ devices: [switchDevice({ additionalServices: [{}] })] });
		expect(registered(api)[0].services.map((s) => s.UUID)).toEqual(["information", "switch"]);
	});

	test("warns about a characteristic the additional service does not have", () => {
		const device = sensor();
		device.additionalServices[0].characteristics.push({ characteristic: "Nope" });
		const { log } = launch({ devices: [device] });
		expect(log).toHaveBeenCalledWith(
			'[Air] WARNING: service "humidity" (HumiditySensor) has no characteristic "Nope" to bind, or it is not listed in optionCharacteristic'
		);
	});

	test("the startup log counts the services", () => {
		const { log } = launch({ devices: [sensor()] });
		expect(log).toHaveBeenCalledWith('Configured Device "Air" with 4 characteristic(s) and 2 additional service(s)');
	});

	test("the identity of the accessory does not depend on the additional services", () => {
		const plain = registered(launch({ devices: [sensor({ additionalServices: [] })] }).api)[0].UUID;
		const extended = registered(launch({ devices: [sensor()] }).api)[0].UUID;
		expect(extended).toBe(plain);
	});
});

describe("polling", () => {
	const lamp = (extra = {}) => ({
		name: "Lamp",
		service: "Lightbulb",
		optionCharacteristic: ["Brightness"],
		forceRefreshDelay: 5,
		characteristics: [
			{ characteristic: "On", get: { url: "http://h/status" } },
			{
				characteristic: "Brightness",
				get: { url: "http://h/status", mappers: [{ type: "static", mapping: [{ from: "7", to: "70" }] }] },
			},
		],
		...extra,
	});

	test("characteristics on the same request share one poll and publish coerced values", async () => {
		jest.useFakeTimers();
		responses["http://h/status"] = "7";
		const { api } = launch({ devices: [lamp()] });
		const [on, brightness] = serviceOf(registered(api)[0], "light").characteristics;

		await jest.advanceTimersByTimeAsync(0);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(on.updateValue).toHaveBeenLastCalledWith("7");
		expect(brightness.updateValue).toHaveBeenLastCalledWith(70);

		await jest.advanceTimersByTimeAsync(5000);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	test("answers a get from the polled value without a request", async () => {
		jest.useFakeTimers();
		responses["http://h/status"] = "7";
		const { api } = launch({ devices: [lamp()] });
		await jest.advanceTimersByTimeAsync(0);
		fetchMock.mockClear();
		const [on] = serviceOf(registered(api)[0], "light").characteristics;
		expect(await on.getHandler()).toBe("7");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("keeps polling after a failed request", async () => {
		jest.useFakeTimers();
		responses["http://h/status"] = new Error("down");
		const { api, log } = launch({ devices: [lamp()] });
		await jest.advanceTimersByTimeAsync(0);
		expect(log).toHaveBeenCalledWith("[Lamp] Poller for %s errored: %s", "On", "down");

		responses["http://h/status"] = "7";
		await jest.advanceTimersByTimeAsync(5000);
		expect(serviceOf(registered(api)[0], "light").characteristics[0].updateValue).toHaveBeenLastCalledWith("7");
	});

	describe("log noise of a failing poll", () => {
		const logged = (log, message, name = "On") =>
			log.mock.calls.filter((call) => call[0] === `[Lamp] ${message}` && call[1] === name);
		const minutes = (count) => count * 60 * 1000;

		test("logs the first failure once and not every poll", async () => {
			jest.useFakeTimers();
			responses["http://h/status"] = { status: 503, body: "" };
			const { log } = launch({ devices: [lamp()] });
			await jest.advanceTimersByTimeAsync(minutes(4));
			expect(logged(log, "Poller for %s errored: %s")).toHaveLength(1);
			expect(logged(log, "Poller for %s is still failing after %s: %s")).toHaveLength(0);
		});

		test("reminds every five minutes while it keeps failing", async () => {
			jest.useFakeTimers();
			responses["http://h/status"] = { status: 503, body: "" };
			const { log } = launch({ devices: [lamp()] });
			await jest.advanceTimersByTimeAsync(minutes(5) + 10000);
			const reminders = logged(log, "Poller for %s is still failing after %s: %s");
			expect(reminders).toHaveLength(1);
			expect(reminders[0].slice(1)).toEqual(["On", "5m", "HTTP 503 Service Unavailable"]);
			await jest.advanceTimersByTimeAsync(minutes(5));
			expect(logged(log, "Poller for %s is still failing after %s: %s")).toHaveLength(2);
		});

		test("logs the recovery and starts over for a new failure", async () => {
			jest.useFakeTimers();
			responses["http://h/status"] = { status: 503, body: "" };
			const { log } = launch({ devices: [lamp()] });
			await jest.advanceTimersByTimeAsync(minutes(2));

			responses["http://h/status"] = "7";
			await jest.advanceTimersByTimeAsync(10000);
			expect(logged(log, "Poller for %s recovered after %s")).toHaveLength(1);
			expect(logged(log, "Poller for %s recovered after %s")[0][2]).toBe("2m");

			await jest.advanceTimersByTimeAsync(minutes(1));
			expect(logged(log, "Poller for %s recovered after %s")).toHaveLength(1);

			responses["http://h/status"] = { status: 503, body: "" };
			await jest.advanceTimersByTimeAsync(10000);
			expect(logged(log, "Poller for %s errored: %s")).toHaveLength(2);
		});

		test("a healthy poll logs nothing", async () => {
			jest.useFakeTimers();
			responses["http://h/status"] = "7";
			const { log } = launch({ devices: [lamp()] });
			await jest.advanceTimersByTimeAsync(minutes(10));
			expect(logged(log, "Poller for %s errored: %s")).toHaveLength(0);
			expect(logged(log, "Poller for %s recovered after %s")).toHaveLength(0);
		});
	});

	test("a failed poll makes HomeKit reads fail until a poll succeeds", async () => {
		jest.useFakeTimers();
		responses["http://h/status"] = "7";
		const { api } = launch({ devices: [lamp()] });
		const [on] = serviceOf(registered(api)[0], "light").characteristics;
		await jest.advanceTimersByTimeAsync(0);
		expect(await on.getHandler()).toBe("7");

		responses["http://h/status"] = { status: 401, body: "{}" };
		await jest.advanceTimersByTimeAsync(5000);
		await expect(on.getHandler()).rejects.toMatchObject({ status: -70402 });

		responses["http://h/status"] = "8";
		await jest.advanceTimersByTimeAsync(5000);
		expect(await on.getHandler()).toBe("8");
	});

	test("a poll that fails before it ever succeeded makes HomeKit reads fail", async () => {
		jest.useFakeTimers();
		responses["http://h/status"] = { status: 401, body: "" };
		const { api } = launch({ devices: [lamp()] });
		const [on] = serviceOf(registered(api)[0], "light").characteristics;
		await jest.advanceTimersByTimeAsync(0);
		await expect(on.getHandler()).rejects.toMatchObject({ status: -70402 });
	});

	test("an inconclusive poll without a fallback makes HomeKit reads fail", async () => {
		jest.useFakeTimers();
		responses["http://h/status"] = "7";
		const device = lamp({
			characteristics: [
				{
					characteristic: "On",
					get: { url: "http://h/status", mappers: [{ type: "static", mapping: [{ from: "7", to: "inconclusive" }] }] },
				},
			],
		});
		const { api } = launch({ devices: [device] });
		const [on] = serviceOf(registered(api)[0], "light").characteristics;
		await jest.advanceTimersByTimeAsync(0);
		await expect(on.getHandler()).rejects.toMatchObject({ status: -70402 });
	});

	test("resultOnError keeps HomeKit reads working while polls fail", async () => {
		jest.useFakeTimers();
		responses["http://h/status"] = { status: 503, body: "" };
		const device = lamp();
		device.characteristics[0].get.resultOnError = "0";
		const { api } = launch({ devices: [device] });
		const [on] = serviceOf(registered(api)[0], "light").characteristics;
		await jest.advanceTimersByTimeAsync(0);
		expect(await on.getHandler()).toBe("0");
	});

	test("stops when Homebridge shuts down", async () => {
		jest.useFakeTimers();
		responses["http://h/status"] = "7";
		const { api } = launch({ devices: [lamp()] });
		await jest.advanceTimersByTimeAsync(0);
		api.emit("shutdown");
		fetchMock.mockClear();
		await jest.advanceTimersByTimeAsync(20000);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("does not poll characteristics without a get action", async () => {
		jest.useFakeTimers();
		launch({
			devices: [{ name: "Pump", service: "Switch", forceRefreshDelay: 5, characteristics: [{ characteristic: "On" }] }],
		});
		await jest.advanceTimersByTimeAsync(20000);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("authentication", () => {
	const get = async (config, device = {}) => {
		const { api, log } = launch({ ...config, devices: [{ ...switchDevice(), ...device }] });
		const characteristic = serviceOf(registered(api)[0]).characteristics[0];
		const result = await characteristic.getHandler().catch((error) => error);
		return { result, log };
	};
	const header = (call) => initOf(call).headers.Authorization;

	test("uses the platform default token and lets a device override it", async () => {
		await get({ defaults: { bearerToken: "platform" } });
		await get({ defaults: { bearerToken: "platform" } }, { bearerToken: "device" });
		expect(header(0)).toBe("Bearer platform");
		expect(header(1)).toBe("Bearer device");
	});

	test("lets a single action override the device token", async () => {
		const device = switchDevice({ bearerToken: "device" });
		device.characteristics[0].get.bearerToken = "action";
		const { api } = launch({ devices: [device] });
		await serviceOf(registered(api)[0]).characteristics[0].getHandler();
		await serviceOf(registered(api)[0]).characteristics[0].setHandler("1");
		expect(header(0)).toBe("Bearer action");
		expect(header(1)).toBe("Bearer device");
	});

	test("fails requests when the token source is unreadable and says why", async () => {
		const { result, log } = await get({}, { bearerToken: "env:HHAA_PLATFORM_MISSING", username: "u", password: "p" });
		expect(result).toMatchObject({ status: -70402 });
		expect(fetchMock).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledWith(expect.stringContaining("HHAA_PLATFORM_MISSING"));
	});

	test("fails only the action whose token override is unreadable", async () => {
		const device = switchDevice();
		device.characteristics[0].get.bearerToken = "env:HHAA_ACTION_PLATFORM_MISSING";
		const { api } = launch({ devices: [device] });
		const characteristic = serviceOf(registered(api)[0]).characteristics[0];
		await expect(characteristic.getHandler()).rejects.toMatchObject({ status: -70402 });
		await characteristic.setHandler("1");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("debug logging never contains tokens", async () => {
		responses["http://h/status"] = "RUN";
		const { api, log } = launch({
			defaults: { bearerToken: "super-secret-token", debug: true },
			devices: [switchDevice({ password: "super-secret-password" })],
		});
		const characteristic = serviceOf(registered(api)[0]).characteristics[0];
		await characteristic.getHandler();
		await characteristic.setHandler("1");
		expect(JSON.stringify(log.mock.calls)).not.toMatch(/super-secret/);
	});
});

describe("custom headers", () => {
	const open = (config) => {
		const { api, log } = launch(config);
		return { characteristic: serviceOf(registered(api)[0]).characteristics[0], log };
	};

	test("combines the headers of the defaults, the device and the action", async () => {
		const device = switchDevice({
			headers: [
				{ name: "X-Device", value: "d" },
				{ name: "x-shared", value: "device" },
			],
		});
		device.characteristics[0].set.headers = [{ name: "Content-Type", value: "application/json" }];
		const { characteristic } = open({
			defaults: {
				headers: [
					{ name: "X-Default", value: "p" },
					{ name: "X-Shared", value: "default" },
				],
			},
			devices: [device],
		});
		await characteristic.getHandler();
		await characteristic.setHandler("1");
		expect(initOf(0).headers).toEqual({ "X-Default": "p", "x-shared": "device", "X-Device": "d" });
		expect(initOf(1).headers).toEqual({
			"X-Default": "p",
			"x-shared": "device",
			"X-Device": "d",
			"Content-Type": "application/json",
		});
	});

	test("fails requests when a value cannot be read and says why", async () => {
		const { characteristic, log } = open({
			devices: [switchDevice({ headers: [{ name: "X-Key", value: "env:HHAA_PLATFORM_HEADER_MISSING" }] })],
		});
		await expect(characteristic.getHandler()).rejects.toMatchObject({ status: -70402 });
		expect(fetchMock).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledWith(expect.stringContaining("HHAA_PLATFORM_HEADER_MISSING"));
	});

	test("a device with a wrong header name is not added and the others are", () => {
		const { api, log } = launch({
			devices: [switchDevice({ name: "Bad", headers: [{ name: "bad name", value: "x" }] }), switchDevice()],
		});
		expect(registered(api)).toHaveLength(1);
		expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/^Device "Bad": .*header/i));
	});

	test("debug logging never contains header values", async () => {
		const { characteristic, log } = open({
			defaults: { debug: true },
			devices: [switchDevice({ headers: [{ name: "X-Api-Key", value: "super-secret-key" }] })],
		});
		await characteristic.getHandler();
		await characteristic.setHandler("1");
		expect(JSON.stringify(log.mock.calls)).not.toMatch(/super-secret/);
	});
});

describe("platform settings", () => {
	test("device settings win over defaults and coercion applies to both", async () => {
		jest.useFakeTimers();
		responses["http://h/status"] = "RUN";
		const { api } = launch({
			defaults: { forceRefreshDelay: "5", timeout: 1000 },
			devices: [switchDevice({ forceRefreshDelay: 0 }), { ...switchDevice(), name: "Polled" }],
		});
		const [, polled] = registered(api);
		await jest.advanceTimersByTimeAsync(0);
		// Only the device that inherits the default interval polls
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(serviceOf(polled).characteristics[0].updateValue).toHaveBeenCalledWith("1");
	});
});
