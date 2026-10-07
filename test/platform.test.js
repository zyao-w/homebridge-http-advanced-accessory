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

class FakeAccessory {
	constructor(displayName, UUID) {
		this.displayName = displayName;
		this.UUID = UUID;
		this.services = [];
	}
	getService(Type) {
		return this.services.find((service) => service instanceof Type);
	}
	addService(Type, name) {
		const service = new Type(name);
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
			Service: { AccessoryInformation: InformationService, Switch: SwitchService, Lightbulb: LightService },
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
