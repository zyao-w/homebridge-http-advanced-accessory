const Wizard = require("../homebridge-ui/public/wizard.js");
const { prepareDevice } = require("../src/prepare-device.js");
const handlers = require("../src/ui-handlers.js");

const answersFor = (kind, extra = {}) => ({
	...Wizard.newAnswers(kind),
	name: "Test device",
	url: "http://device.local/api",
	...extra,
});

/** Builds the device and runs the get of its main characteristic against a fixed response. */
async function read(device, body, characteristic) {
	const fetch = async () => ({ status: 200, text: async () => body });
	const result = await handlers.createTestGet({ fetch })({ device, characteristic });
	return result.ok ? result.value : `ERROR: ${result.error}`;
}

describe("the kinds of device", () => {
	test("every kind builds a device that the plugin loads", () => {
		for (const kind of Object.keys(Wizard.KINDS)) {
			const device = Wizard.buildDevice(answersFor(kind));
			const prepared = prepareDevice(device, {});
			expect({ kind, errors: prepared.validationErrors, error: prepared.error && prepared.error.message }).toEqual({
				kind,
				errors: [],
				error: null,
			});
			expect(device.service).toBe(Wizard.KINDS[kind].service);
			expect(device.characteristics[0].characteristic).toBe(Wizard.KINDS[kind].characteristic);
		}
	});

	test("the services and characteristics are the ones of HomeKit", () => {
		const names = Object.values(Wizard.KINDS).map((kind) => `${kind.service}/${kind.characteristic}`);
		expect(names).toEqual(
			expect.arrayContaining(["TemperatureSensor/CurrentTemperature", "ContactSensor/ContactSensorState", "Switch/On"])
		);
	});

	test("the steps depend on whether the device can be controlled", () => {
		expect(Wizard.stepsFor("")).toEqual(["kind"]);
		expect(Wizard.stepsFor("temperature")).toEqual(["kind", "connection", "pick", "interpret", "options", "summary"]);
		expect(Wizard.stepsFor("switch")).toEqual(["kind", "connection", "pick", "interpret", "set", "options", "summary"]);
	});
});

describe("building a sensor that is read", () => {
	test("a temperature from JSON becomes a number, rounded when asked", async () => {
		const answers = answersFor("temperature", {
			pick: { type: "jpath", path: "$.data.temp", regexp: "", capture: "1" },
			round: "1",
		});
		const device = Wizard.buildDevice(answers);
		expect(device.characteristics[0].get.mappers).toEqual([
			{ type: "jpath", jpath: "$.data.temp" },
			{ type: "number", round: 1 },
		]);
		expect(await read(device, '{"data": {"temp": "21.46"}}', "CurrentTemperature")).toBe("21.5");
		expect(await read(device, '{"data": {"temp": "offline"}}', "CurrentTemperature")).toMatch(/^ERROR: Inconclusive/);
	});

	test("reads plain text with a regular expression", async () => {
		const answers = answersFor("humidity", { pick: { type: "regex", path: "", regexp: "hum=(\\d+)", capture: "" } });
		const device = Wizard.buildDevice(answers);
		expect(device.characteristics[0].get.mappers[0]).toEqual({ type: "regex", regexp: "hum=(\\d+)", capture: "1" });
		expect(await read(device, "t=20 hum=55", "CurrentRelativeHumidity")).toBe("55");
	});

	test("reads XML", async () => {
		const answers = answersFor("temperature", {
			pick: { type: "xpath", path: "/r/t/text()", regexp: "", capture: "1" },
		});
		expect(await read(Wizard.buildDevice(answers), "<r><t>19</t></r>", "CurrentTemperature")).toBe("19");
	});

	test("takes the whole response when no value is picked", async () => {
		expect(await read(Wizard.buildDevice(answersFor("temperature")), " 18.5 ", "CurrentTemperature")).toBe("18.5");
	});

	test("a contact sensor turns the words of the device into 1 and 0, and rejects anything else", async () => {
		const answers = answersFor("contact", {
			pick: { type: "jpath", path: "$.zone", regexp: "", capture: "1" },
			triggeredText: "ALARM",
			normalText: "NORMAL",
		});
		const device = Wizard.buildDevice(answers);
		expect(await read(device, '{"zone": "ALARM"}', "ContactSensorState")).toBe("1");
		expect(await read(device, '{"zone": "NORMAL"}', "ContactSensorState")).toBe("0");
		expect(await read(device, '{"zone": true}', "ContactSensorState")).toBe("1");
		expect(await read(device, '{"zone": false}', "ContactSensorState")).toBe("0");
		expect(await read(device, '{"zone": "weird"}', "ContactSensorState")).toMatch(/^ERROR/);
	});

	test("does not repeat a text in the mapping", () => {
		const device = Wizard.buildDevice(answersFor("motion", { triggeredText: "true", normalText: "false" }));
		const mapping = device.characteristics[0].get.mappers[0].mapping;
		expect(mapping).toEqual([
			{ from: "true", to: "1" },
			{ from: "false", to: "0" },
		]);
	});
});

describe("building a switch or a light", () => {
	const switchAnswers = (extra = {}) =>
		answersFor("switch", {
			pick: { type: "jpath", path: "$.power", regexp: "", capture: "1" },
			onText: "on",
			offText: "off",
			set: {
				enabled: true,
				url: "http://device.local/power?v={value}",
				httpMethod: "GET",
				body: "",
				onValue: "on",
				offValue: "off",
			},
			...extra,
		});

	test("reads the state and sets it", async () => {
		const device = Wizard.buildDevice(switchAnswers());
		expect(await read(device, '{"power": "on"}', "On")).toBe("1");
		expect(await read(device, '{"power": "off"}', "On")).toBe("0");

		expect(handlers.previewSet({ device, characteristic: "On", value: "true" })).toMatchObject({
			ok: true,
			url: "http://device.local/power?v=on",
		});
		expect(handlers.previewSet({ device, characteristic: "On", value: "false" })).toMatchObject({
			url: "http://device.local/power?v=off",
		});
	});

	test("understands the 1 and 0 that HomeKit may send", () => {
		const device = Wizard.buildDevice(switchAnswers());
		expect(handlers.previewSet({ device, characteristic: "On", value: "1" }).url).toMatch(/v=on$/);
		expect(handlers.previewSet({ device, characteristic: "On", value: "0" }).url).toMatch(/v=off$/);
	});

	test("sends the body of a POST", () => {
		const answers = switchAnswers();
		answers.set = {
			...answers.set,
			url: "http://device.local/power",
			httpMethod: "POST",
			body: '{"on": {value}}',
			onValue: "true",
			offValue: "false",
		};
		const device = Wizard.buildDevice(answers);
		expect(handlers.previewSet({ device, characteristic: "On", value: "true" })).toMatchObject({
			method: "POST",
			body: '{"on": true}',
		});
	});

	test("without a set action, HomeKit can only show the state", () => {
		const device = Wizard.buildDevice(switchAnswers({ set: { ...switchAnswers().set, enabled: false } }));
		expect(device.characteristics[0]).not.toHaveProperty("set");
	});

	test("sends {value} as it is when no words are given for on and off", () => {
		const answers = switchAnswers();
		answers.set = { ...answers.set, onValue: "", offValue: "" };
		expect(Wizard.buildDevice(answers).characteristics[0].set).not.toHaveProperty("mappers");
	});

	test("a light can also read and set the brightness, converted to 0-100", async () => {
		const answers = answersFor("lightbulb", {
			pick: { type: "jpath", path: "$.on", regexp: "", capture: "1" },
			brightness: {
				enabled: true,
				pick: { type: "jpath", path: "$.level", regexp: "", capture: "1" },
				deviceMax: "255",
				setEnabled: true,
				setUrl: "http://device.local/level?v={value}",
				setHttpMethod: "GET",
				setBody: "",
			},
		});
		const device = Wizard.buildDevice(answers);
		expect(device.optionCharacteristic).toEqual(["Brightness"]);
		expect(device.characteristics.map((entry) => entry.characteristic)).toEqual(["On", "Brightness"]);
		expect(prepareDevice(device, {}).device).not.toBeNull();

		expect(await read(device, '{"on": true, "level": 255}', "Brightness")).toBe("100");
		expect(await read(device, '{"on": true, "level": 128}', "Brightness")).toBe("50");
		expect(handlers.previewSet({ device, characteristic: "Brightness", value: "50" }).url).toBe(
			"http://device.local/level?v=128"
		);
	});

	test("a light with percentages needs no conversion", () => {
		const device = Wizard.buildDevice(
			answersFor("lightbulb", {
				brightness: {
					...Wizard.newAnswers("").brightness,
					enabled: true,
					setEnabled: true,
					setUrl: "http://x?v={value}",
				},
			})
		);
		expect(device.characteristics[1].get.mappers).toEqual([{ type: "number" }]);
		expect(device.characteristics[1].set).toEqual({ url: "http://x?v={value}" });
	});
});

describe("the settings of the device", () => {
	test("polls, reports faults and keeps the id only when asked", () => {
		const plain = Wizard.buildDevice(answersFor("temperature", { pollInterval: "" }));
		expect(plain).not.toHaveProperty("forceRefreshDelay");
		expect(plain).not.toHaveProperty("statusFault");
		expect(plain).not.toHaveProperty("id");

		const asked = Wizard.buildDevice(
			answersFor("temperature", { pollInterval: "30", statusFault: true, id: " temp-1 " })
		);
		expect(asked).toMatchObject({ forceRefreshDelay: 30, statusFault: true, id: "temp-1" });
	});

	test("authenticates with a bearer token or with a username and password", () => {
		expect(
			Wizard.buildDevice(answersFor("temperature", { authType: "bearer", bearerToken: " env:TOKEN " }))
		).toMatchObject({
			bearerToken: "env:TOKEN",
		});
		const basic = Wizard.buildDevice(
			answersFor("temperature", { authType: "basic", username: "admin", password: "pw" })
		);
		expect(basic).toMatchObject({ username: "admin", password: "pw" });
		expect(basic).not.toHaveProperty("bearerToken");
		expect(Wizard.buildDevice(answersFor("temperature"))).not.toHaveProperty("bearerToken");
	});

	test("sends the method and body of the request", () => {
		const device = Wizard.buildDevice(answersFor("temperature", { httpMethod: "POST", body: '{"q": 1}' }));
		expect(device.characteristics[0].get).toMatchObject({ httpMethod: "POST", body: '{"q": 1}' });
	});

	test("refuses an unknown kind", () => {
		expect(() => Wizard.buildDevice(Wizard.newAnswers("toaster"))).toThrow(/Unknown kind/);
	});
});

describe("probeDevice", () => {
	test("is the request alone, so that the response can be seen before choosing a value", async () => {
		const answers = answersFor("temperature", {
			authType: "bearer",
			bearerToken: "abc",
			pick: { type: "jpath", path: "$.x", regexp: "", capture: "1" },
		});
		const device = Wizard.probeDevice(answers);
		expect(device.characteristics[0].get).toEqual({ url: "http://device.local/api" });
		expect(device.bearerToken).toBe("abc");
		expect(await read(device, '{"x": 1}', "CurrentTemperature")).toBe('{"x": 1}');
	});

	test("works before anything is filled in", () => {
		expect(Wizard.probeDevice(Wizard.newAnswers("")).name).toBe("Test");
	});
});

describe("problems", () => {
	test("each step names what is missing", () => {
		const answers = Wizard.newAnswers("");
		expect(Wizard.problems(answers, "kind")).toEqual(["kind"]);

		answers.kind = "temperature";
		expect(Wizard.problems(answers, "kind")).toEqual([]);
		expect(Wizard.problems(answers, "connection")).toEqual(["name", "url"]);

		answers.name = "T";
		answers.url = "ftp://x";
		expect(Wizard.problems(answers, "connection")).toEqual(["url"]);
		answers.url = "http://x";
		expect(Wizard.problems(answers, "connection")).toEqual([]);

		answers.authType = "bearer";
		expect(Wizard.problems(answers, "connection")).toEqual(["bearerToken"]);
		answers.authType = "basic";
		expect(Wizard.problems(answers, "connection")).toEqual(["username"]);
	});

	test("a path is needed only when a way of finding the value is chosen", () => {
		const answers = answersFor("temperature");
		expect(Wizard.problems(answers, "pick")).toEqual([]);
		answers.pick.type = "jpath";
		expect(Wizard.problems(answers, "pick")).toEqual(["pick.path"]);
		answers.pick.type = "regex";
		expect(Wizard.problems(answers, "pick")).toEqual(["pick.regexp"]);
		answers.pick.regexp = "(\\d+)";
		expect(Wizard.problems(answers, "pick")).toEqual([]);
	});

	test("the decimals, the maximum brightness and the interval must be numbers in range", () => {
		const answers = answersFor("lightbulb");
		answers.brightness.enabled = true;
		answers.brightness.deviceMax = "0";
		expect(Wizard.problems(answers, "interpret")).toEqual(["brightness.deviceMax"]);

		const sensor = answersFor("temperature", { round: "11" });
		expect(Wizard.problems(sensor, "interpret")).toEqual(["round"]);
		sensor.round = "1.5";
		expect(Wizard.problems(sensor, "interpret")).toEqual(["round"]);
		sensor.round = "";
		expect(Wizard.problems(sensor, "interpret")).toEqual([]);

		sensor.pollInterval = "-1";
		expect(Wizard.problems(sensor, "options")).toEqual(["pollInterval"]);
		sensor.pollInterval = "";
		expect(Wizard.problems(sensor, "options")).toEqual([]);
	});

	test("the set step needs a URL only when it is switched on", () => {
		const answers = answersFor("switch");
		expect(Wizard.problems(answers, "set")).toEqual([]);
		answers.set.enabled = true;
		expect(Wizard.problems(answers, "set")).toEqual(["set.url"]);
	});

	test("every kind can be completed with the defaults and a name and URL", () => {
		for (const kind of Object.keys(Wizard.KINDS)) {
			const answers = answersFor(kind);
			for (const step of Wizard.stepsFor(kind)) {
				expect({ kind, step, problems: Wizard.problems(answers, step) }).toEqual({ kind, step, problems: [] });
			}
		}
	});
});

describe("blankDevice", () => {
	test("loads, so that it can be edited right away", () => {
		const prepared = prepareDevice(Wizard.blankDevice(), {});
		expect(prepared.error).toBeNull();
		expect(prepared.validationErrors).toEqual([]);
		expect(Wizard.blankDevice("Mine").name).toBe("Mine");
	});
});
