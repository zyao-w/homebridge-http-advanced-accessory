// What the setup wizard knows about the kinds of device it can set up, and how it turns the answers of the user into
// the same device settings that the form of the plugin edits. Pure functions, no DOM: the file runs in the browser and
// in Node (for the tests). The first version covers sensors that are only read, and switches and lights.
(function (root, factory) {
	const api = factory();
	if (typeof module === "object" && module.exports) module.exports = api;
	else root.HttpAdvancedWizard = api;
})(typeof self !== "undefined" ? self : this, function () {
	// `value` tells how the response becomes a HomeKit value: a number, a 0/1 state, or the state of a control
	const KINDS = {
		temperature: {
			group: "sensor",
			value: "number",
			service: "TemperatureSensor",
			characteristic: "CurrentTemperature",
		},
		humidity: {
			group: "sensor",
			value: "number",
			service: "HumiditySensor",
			characteristic: "CurrentRelativeHumidity",
		},
		motion: { group: "sensor", value: "binary", service: "MotionSensor", characteristic: "MotionDetected" },
		contact: { group: "sensor", value: "binary", service: "ContactSensor", characteristic: "ContactSensorState" },
		leak: { group: "sensor", value: "binary", service: "LeakSensor", characteristic: "LeakDetected" },
		smoke: { group: "sensor", value: "binary", service: "SmokeSensor", characteristic: "SmokeDetected" },
		occupancy: { group: "sensor", value: "binary", service: "OccupancySensor", characteristic: "OccupancyDetected" },
		switch: { group: "control", value: "state", service: "Switch", characteristic: "On" },
		lightbulb: { group: "control", value: "state", service: "Lightbulb", characteristic: "On", brightness: true },
	};

	const PICK_TYPES = ["none", "jpath", "xpath", "regex"];
	const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

	const text = (value) => (typeof value === "string" ? value.trim() : "");
	const isBlank = (value) => text(value) === "";
	const number = (value) => (isBlank(value) ? NaN : Number(value));

	function newPick(type = "none") {
		return { type, path: "", regexp: "", capture: "1" };
	}

	/** The answers of a wizard that has just started. */
	function newAnswers(kind) {
		return {
			kind: kind || "",
			name: "",
			id: "",
			url: "",
			httpMethod: "GET",
			body: "",
			authType: "none",
			bearerToken: "",
			username: "",
			password: "",
			pick: newPick(),
			round: "",
			triggeredText: "",
			normalText: "",
			onText: "",
			offText: "",
			set: { enabled: false, url: "", httpMethod: "GET", body: "", onValue: "1", offValue: "0" },
			brightness: {
				enabled: false,
				pick: newPick(),
				deviceMax: "100",
				setEnabled: false,
				setUrl: "",
				setHttpMethod: "GET",
				setBody: "",
			},
			pollInterval: "30",
			statusFault: false,
		};
	}

	/** The steps to go through for a kind, in order. */
	function stepsFor(kind) {
		const info = KINDS[kind];
		if (!info) return ["kind"];
		return info.group === "control"
			? ["kind", "connection", "pick", "interpret", "set", "options", "summary"]
			: ["kind", "connection", "pick", "interpret", "options", "summary"];
	}

	function validUrl(value) {
		try {
			const url = new URL(text(value));
			return url.protocol === "http:" || url.protocol === "https:";
		} catch {
			return false;
		}
	}

	function pickProblem(pick, prefix) {
		if (!pick || pick.type === "none") return [];
		if (!PICK_TYPES.includes(pick.type)) return [`${prefix}.type`];
		return isBlank(pick.type === "regex" ? pick.regexp : pick.path)
			? [`${prefix}.${pick.type === "regex" ? "regexp" : "path"}`]
			: [];
	}

	/** The answers that are missing or wrong in a step, by field. An empty list means the step is complete. */
	function problems(answers, step) {
		const found = [];
		const info = KINDS[answers.kind];

		if (step === "kind") {
			if (!info) found.push("kind");
		} else if (step === "connection") {
			if (isBlank(answers.name)) found.push("name");
			if (!validUrl(answers.url)) found.push("url");
			if (!HTTP_METHODS.includes(answers.httpMethod)) found.push("httpMethod");
			if (answers.authType === "bearer" && isBlank(answers.bearerToken)) found.push("bearerToken");
			if (answers.authType === "basic" && isBlank(answers.username)) found.push("username");
		} else if (step === "pick") {
			found.push(...pickProblem(answers.pick, "pick"));
			if (info && info.brightness && answers.brightness.enabled) {
				found.push(...pickProblem(answers.brightness.pick, "brightness.pick"));
			}
		} else if (step === "interpret") {
			if (info && info.value === "number" && !isBlank(answers.round)) {
				const round = number(answers.round);
				if (!Number.isInteger(round) || round < 0 || round > 10) found.push("round");
			}
			if (info && info.brightness && answers.brightness.enabled) {
				const max = number(answers.brightness.deviceMax);
				if (!Number.isFinite(max) || max <= 0) found.push("brightness.deviceMax");
			}
		} else if (step === "set") {
			if (answers.set.enabled) {
				if (isBlank(answers.set.url)) found.push("set.url");
				if (!HTTP_METHODS.includes(answers.set.httpMethod)) found.push("set.httpMethod");
			}
			if (info && info.brightness && answers.brightness.enabled && answers.brightness.setEnabled) {
				if (isBlank(answers.brightness.setUrl)) found.push("brightness.setUrl");
			}
		} else if (step === "options") {
			if (!isBlank(answers.pollInterval)) {
				const interval = number(answers.pollInterval);
				if (!Number.isFinite(interval) || interval < 0) found.push("pollInterval");
			}
		}
		return found;
	}

	const pickMapper = (pick) => {
		if (!pick || pick.type === "none") return [];
		if (pick.type === "regex") return [{ type: "regex", regexp: pick.regexp, capture: text(pick.capture) || "1" }];
		return [{ type: pick.type, [pick.type]: text(pick.path) }];
	};

	// A mapping lists the texts the user named, then what a JSON true or false means, without repeating a text
	function statePairs(oneText, zeroText) {
		const pairs = [];
		const add = (from, to) => {
			if (!isBlank(from) && !pairs.some((pair) => pair.from === from)) pairs.push({ from, to });
		};
		add(text(oneText), "1");
		add(text(zeroText), "0");
		add("true", "1");
		add("false", "0");
		return pairs;
	}

	/** The mappers that turn the response into the value of the main characteristic. */
	function readMappers(answers) {
		const info = KINDS[answers.kind];
		const mappers = pickMapper(answers.pick);
		if (info.value === "number") {
			const round = number(answers.round);
			mappers.push(Number.isInteger(round) ? { type: "number", round } : { type: "number" });
		} else if (info.value === "binary") {
			mappers.push({ type: "static", mapping: statePairs(answers.triggeredText, answers.normalText) });
			// Anything else is an error and not made-up state
			mappers.push({ type: "number" });
		} else {
			mappers.push({ type: "static", mapping: statePairs(answers.onText, answers.offText) });
			mappers.push({ type: "number" });
		}
		return mappers;
	}

	function brightnessCharacteristic(answers) {
		const { brightness } = answers;
		const max = number(brightness.deviceMax);
		const scaled = Number.isFinite(max) && max !== 100;
		const get = {
			url: text(answers.url),
			mappers: [
				...pickMapper(brightness.pick),
				{ type: "number" },
				...(scaled
					? [{ type: "scale", inputMin: 0, inputMax: max, outputMin: 0, outputMax: 100, round: 0, clamp: true }]
					: []),
			],
		};
		if (answers.httpMethod !== "GET") get.httpMethod = answers.httpMethod;
		if (!isBlank(answers.body)) get.body = answers.body;

		const entry = { characteristic: "Brightness", get };
		if (brightness.setEnabled) {
			entry.set = { url: text(brightness.setUrl) };
			if (brightness.setHttpMethod !== "GET") entry.set.httpMethod = brightness.setHttpMethod;
			if (!isBlank(brightness.setBody)) entry.set.body = brightness.setBody;
			if (scaled) {
				entry.set.mappers = [
					{ type: "scale", inputMin: 0, inputMax: 100, outputMin: 0, outputMax: max, round: 0, clamp: true },
				];
			}
		}
		return entry;
	}

	function getAction(answers, mappers) {
		const get = { url: text(answers.url) };
		if (answers.httpMethod !== "GET") get.httpMethod = answers.httpMethod;
		if (!isBlank(answers.body)) get.body = answers.body;
		if (mappers && mappers.length > 0) get.mappers = mappers;
		return get;
	}

	function authSettings(answers) {
		if (answers.authType === "bearer") return { bearerToken: text(answers.bearerToken) };
		if (answers.authType === "basic") return { username: text(answers.username), password: answers.password || "" };
		return {};
	}

	/**
	 * A device with only the request of the user and no mappers: enough to see what the device answers. It is not
	 * meant to be saved.
	 */
	function probeDevice(answers) {
		const info = KINDS[answers.kind] || KINDS.switch;
		return {
			name: text(answers.name) || "Test",
			service: info.service,
			...authSettings(answers),
			characteristics: [{ characteristic: info.characteristic, get: getAction(answers) }],
		};
	}

	/** The device the wizard sets up. Call it when `problems` is empty for every step. */
	function buildDevice(answers) {
		const info = KINDS[answers.kind];
		if (!info) throw new Error(`Unknown kind of device "${answers.kind}"`);

		const device = { name: text(answers.name), service: info.service };
		if (!isBlank(answers.id)) device.id = text(answers.id);
		const interval = number(answers.pollInterval);
		if (Number.isFinite(interval) && interval > 0) device.forceRefreshDelay = interval;
		Object.assign(device, authSettings(answers));
		if (answers.statusFault) device.statusFault = true;
		if (info.brightness && answers.brightness.enabled) device.optionCharacteristic = ["Brightness"];

		const main = { characteristic: info.characteristic, get: getAction(answers, readMappers(answers)) };
		if (info.group === "control" && answers.set.enabled) {
			const set = { url: text(answers.set.url) };
			if (answers.set.httpMethod !== "GET") set.httpMethod = answers.set.httpMethod;
			if (!isBlank(answers.set.body)) set.body = answers.set.body;
			// HomeKit sends true or false; the device wants its own words for them
			const on = text(answers.set.onValue);
			const off = text(answers.set.offValue);
			if (on || off) {
				set.mappers = [
					{
						type: "static",
						mapping: [
							{ from: "true", to: on },
							{ from: "false", to: off },
							{ from: "1", to: on },
							{ from: "0", to: off },
						],
					},
				];
			}
			main.set = set;
		}

		device.characteristics = [main];
		if (info.brightness && answers.brightness.enabled) device.characteristics.push(brightnessCharacteristic(answers));
		return device;
	}

	/** An empty device for the manager page: it loads, shows nothing yet, and is edited right after. */
	function blankDevice(name) {
		return { name: name || "New device", service: "Switch", characteristics: [] };
	}

	return {
		KINDS,
		PICK_TYPES,
		HTTP_METHODS,
		newAnswers,
		newPick,
		stepsFor,
		problems,
		buildDevice,
		probeDevice,
		blankDevice,
	};
});
