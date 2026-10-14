const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const handlers = require("../src/ui-handlers.js");

// Runs the real page of the custom UI (index.html and its scripts) in jsdom, against a stand-in for the `homebridge`
// object of the Homebridge UI. Requests go to the real handlers of the server, with a fake device behind them.

const publicDir = path.join(__dirname, "..", "homebridge-ui", "public");
const scripts = ["i18n.js", "config-model.js", "wizard.js", "app.js"].map((file) =>
	fs.readFileSync(path.join(publicDir, file), "utf8")
);

const platform = (devices, extra = {}) => ({
	platform: "HttpAdvancedPlatform",
	name: "HTTP Advanced",
	devices,
	...extra,
});
const sensor = (name = "Air", extra = {}) => ({
	name,
	service: "CarbonDioxideSensor",
	characteristics: [
		{
			characteristic: "CarbonDioxideLevel",
			get: { url: "http://air.local/api", mappers: [{ type: "jpath", jpath: "$.co2" }, { type: "number" }] },
		},
	],
	...extra,
});
const lamp = (name = "Lamp") => ({
	name,
	service: "Switch",
	bearerToken: "secret-token",
	characteristics: [{ characteristic: "On", set: { url: "http://lamp.local/power?v={value}" } }],
});

const settle = async (ticks = 8) => {
	for (let i = 0; i < ticks; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

async function waitFor(check, what) {
	for (let i = 0; i < 100; i++) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Gave up waiting for ${what}`);
}

/** Opens the settings page. `config` is what getPluginConfig() returns. */
async function open({
	config = [],
	lang = "en",
	body = '{"co2": "812.4", "t": 21}',
	formAuth = true,
	cached = [],
} = {}) {
	const dom = new JSDOM('<div id="app"></div>', { runScripts: "outside-only", pretendToBeVisual: true });
	const { window } = dom;
	const log = { updates: [], schema: [], toasts: [], forms: [], requests: [] };
	const fetchCalls = [];
	const testGet = handlers.createTestGet({
		fetch: async (url, init) => {
			fetchCalls.push({ url, init });
			return { status: 200, text: async () => body };
		},
	});
	const routes = {
		"/info": () => ({ testsDisabled: !formAuth }),
		"/validate": handlers.validate,
		"/test-get": (payload) => testGet({ ...payload, uiAuth: formAuth ? undefined : "none" }),
		"/preview-set": handlers.previewSet,
		"/import-1x": handlers.importLegacy,
		"/cached": handlers.cachedStatus,
		"/device-schema": handlers.deviceSchema,
		"/defaults-schema": handlers.defaultsSchema,
	};

	const homebridge = new window.EventTarget();
	let current = config;
	Object.assign(homebridge, {
		serverEnv: { formAuth: formAuth ? true : "none" },
		getPluginConfig: async () => current,
		updatePluginConfig: async (blocks) => {
			current = JSON.parse(JSON.stringify(blocks));
			log.updates.push(current);
			return current;
		},
		request: async (route, payload) => {
			log.requests.push(route);
			return routes[route](payload);
		},
		i18nCurrentLang: async () => lang,
		getCachedAccessories: async () => cached,
		showSchemaForm: () => log.schema.push("show"),
		hideSchemaForm: () => log.schema.push("hide"),
		enableSaveButton: () => {},
		fixScrollHeight: () => {},
		toast: Object.fromEntries(
			["success", "error", "warning", "info"].map((kind) => [kind, (m) => log.toasts.push([kind, m])])
		),
		createForm: (schema, data, submit, cancel) => {
			const form = { schema, data, submit, cancel, ended: false };
			form.onChange = (fn) => (form.change = fn);
			form.onSubmit = (fn) => (form.submitted = fn);
			form.onCancel = (fn) => (form.cancelled = fn);
			form.end = () => (form.ended = true);
			log.forms.push(form);
			return form;
		},
	});
	window.homebridge = homebridge;
	for (const script of scripts) window.eval(script);
	await settle();

	const root = window.document.getElementById("app");
	const ui = {
		window,
		root,
		homebridge,
		log,
		fetchCalls,
		config: () => current,
		text: () => root.textContent.replace(/\s+/g, " "),
		$: (selector) => root.querySelector(selector),
		click: async (selector) => {
			const element = root.querySelector(selector);
			if (!element) throw new Error(`Nothing matches ${selector}`);
			element.click();
			await settle();
		},
		type: async (selector, value) => {
			const element = root.querySelector(selector);
			if (!element) throw new Error(`Nothing matches ${selector}`);
			element.value = value;
			element.dispatchEvent(new window.Event("input", { bubbles: true }));
			element.dispatchEvent(new window.Event("change", { bubbles: true }));
			await settle();
		},
		check: async (selector, checked = true) => {
			const element = root.querySelector(selector);
			element.checked = checked;
			element.dispatchEvent(new window.Event("change", { bubbles: true }));
			await settle();
		},
		waitForText: (text) => waitFor(() => ui.text().includes(text), `"${text}" in ${ui.text().slice(0, 300)}`),
		close: () => window.close(),
	};
	return ui;
}

const instances = [];
const start = async (options) => {
	const ui = await open(options);
	instances.push(ui);
	return ui;
};
afterEach(() => instances.splice(0).forEach((ui) => ui.close()));

describe("first run", () => {
	test("opens the wizard when there are no devices, and keeps the standard form out of the way until it is left", async () => {
		const ui = await start();
		expect(ui.text()).toContain("Set up a device");
		expect(ui.text()).toContain("Welcome");
		expect(ui.log.schema).toEqual(["hide"]);

		await ui.click('[data-action="wizard-cancel"]');
		expect(ui.text()).toContain("There are no devices yet.");
		expect(ui.log.schema).toEqual(["hide", "show"]);
		expect(ui.log.updates).toEqual([]);
	});

	test("opens the wizard when the platform has no devices either", async () => {
		const ui = await start({ config: [platform([])] });
		expect(ui.text()).toContain("Set up a device");
	});

	test("opens the manager as cards, with the standard form one button away", async () => {
		const ui = await start({ config: [platform([sensor()])] });
		expect(ui.text()).not.toContain("Set up a device");
		expect(ui.text()).toContain("Air");
		expect(ui.$("[data-device].col .card .card-title").textContent).toBe("Air");
		expect(ui.text()).toContain("CarbonDioxideSensor · 1 characteristic(s)");
		expect(ui.log.schema).toEqual([]);
		expect(ui.text()).toContain("Show standard form");
	});

	test("shows the standard form when the wizard is skipped, since there is nothing else to edit with", async () => {
		const ui = await start();
		await ui.click('[data-action="wizard-cancel"]');
		expect(ui.log.schema.at(-1)).toBe("show");
		expect(ui.text()).toContain("Hide standard form");
	});

	test("a card takes the whole width while its details are open", async () => {
		const ui = await start({ config: [platform([sensor("A"), sensor("B")])] });
		expect(ui.root.querySelectorAll("[data-device].col-12")).toHaveLength(0);
		await ui.click('[data-action="toggle"][data-index="0"]');
		expect([...ui.root.querySelectorAll("[data-device].col-12")].map((card) => card.dataset.device)).toEqual(["0"]);
	});

	test("the standard form is shown even if the page fails to start", async () => {
		const dom = new JSDOM('<div id="app"></div>', { runScripts: "outside-only" });
		const shown = [];
		dom.window.homebridge = Object.assign(new dom.window.EventTarget(), {
			i18nCurrentLang: async () => "en",
			getPluginConfig: async () => {
				throw new Error("config unavailable");
			},
			showSchemaForm: () => shown.push("show"),
		});
		for (const script of scripts) dom.window.eval(script);
		await settle();
		expect(shown).toEqual(["show"]);
		expect(dom.window.document.getElementById("app").textContent).toContain("config unavailable");
		dom.window.close();
	});
});

describe("the wizard", () => {
	test("sets up a temperature sensor from the response of the device", async () => {
		const ui = await start({ body: '{"co2": "812.4", "t": 21.46}' });
		await ui.click('[data-action="wizard-kind"][data-kind="temperature"]');
		expect(ui.$("#w-name").value).toBe("Temperature sensor");

		await ui.click('[data-action="wizard-next"]');
		// Nothing is filled in yet: the step does not move on and names the problem
		expect(ui.text()).toContain("This is required or not valid.");

		await ui.type("#w-url", "http://device.local/api");
		await ui.click('[data-action="wizard-next"]');
		expect(ui.text()).toContain("Read a value");

		await ui.click('[data-action="wizard-send"]');
		await ui.waitForText("The device answered with HTTP 200 (JSON).");
		expect(ui.fetchCalls).toHaveLength(1);
		const suggestions = [...ui.root.querySelectorAll('[data-action="wizard-suggest"]')].map(
			(button) => button.textContent
		);
		expect(suggestions.join("|")).toContain("$.t");

		await ui.click('[data-action="wizard-suggest"][data-i="1"]');
		await ui.waitForText("HomeKit gets");
		expect(ui.text()).toContain("21.46");

		await ui.click('[data-action="wizard-next"]');
		await ui.type("#w-round", "1");
		await ui.click('[data-action="wizard-preview"]');
		await ui.waitForText("21.5");

		await ui.click('[data-action="wizard-next"]');
		await ui.click('[data-action="wizard-next"]');
		expect(ui.text()).toContain("The plugin accepts this device.");

		await ui.click('[data-action="wizard-add"]');
		await ui.waitForText("Temperature sensor");
		const [block] = ui.config();
		expect(block).toMatchObject({ platform: "HttpAdvancedPlatform" });
		expect(block.devices).toEqual([
			{
				name: "Temperature sensor",
				service: "TemperatureSensor",
				forceRefreshDelay: 30,
				characteristics: [
					{
						characteristic: "CurrentTemperature",
						get: {
							url: "http://device.local/api",
							mappers: [
								{ type: "jpath", jpath: "$.t" },
								{ type: "number", round: 1 },
							],
						},
					},
				],
			},
		]);
		expect(ui.log.toasts).toEqual([["success", "Device added. Press Save to keep it."]]);
		// The first device ends the first run: the standard form is no longer shown by itself
		expect(ui.log.schema).not.toContain("show");
		expect(ui.text()).toContain("Show standard form");
	});

	test("sets up a light that can be switched, with a preview of what is sent", async () => {
		const ui = await start({ body: '{"power": "on"}' });
		await ui.click('[data-action="wizard-kind"][data-kind="switch"]');
		await ui.type("#w-url", "http://lamp.local/state");
		await ui.click('[data-action="wizard-next"]');
		await ui.type("#w-pick-type", "jpath");
		await ui.type("#w-pick-path", "$.power");
		await ui.click('[data-action="wizard-next"]');
		await ui.type("#w-onText", "on");
		await ui.type("#w-offText", "off");
		await ui.click('[data-action="wizard-preview"]');
		await ui.waitForText("HomeKit gets: 1");
		await ui.click('[data-action="wizard-next"]');

		expect(ui.text()).toContain("Control it");
		await ui.check("#w-set-enabled");
		await ui.type("#w-set-url", "http://lamp.local/power?v={value}");
		await ui.type("#w-set-onValue", "on");
		await ui.type("#w-set-offValue", "off");
		await ui.click('[data-action="wizard-preview-set"]');
		await ui.waitForText("GET http://lamp.local/power?v=on");
		// Only the request to read was sent; the preview sends nothing
		expect(ui.fetchCalls).toHaveLength(1);

		await ui.click('[data-action="wizard-next"]');
		await ui.click('[data-action="wizard-next"]');
		await ui.click('[data-action="wizard-add"]');
		await ui.waitForText("Switch");
		const device = ui.config()[0].devices[0];
		expect(device.characteristics[0].set.url).toBe("http://lamp.local/power?v={value}");
	});

	test("does not send requests when the Homebridge UI has no login, and says why", async () => {
		const ui = await start({ formAuth: false });
		await ui.click('[data-action="wizard-kind"][data-kind="temperature"]');
		await ui.type("#w-url", "http://device.local/api");
		await ui.click('[data-action="wizard-next"]');
		expect(ui.text()).toContain("Sending test requests is off");
		expect(ui.$('[data-action="wizard-send"]').disabled).toBe(true);
		expect(ui.fetchCalls).toHaveLength(0);

		// The path can still be written by hand
		await ui.type("#w-pick-type", "jpath");
		await ui.type("#w-pick-path", "$.t");
		await ui.click('[data-action="wizard-next"]');
		expect(ui.text()).toContain("Understand the value");
	});

	test("shows why a request or a value was refused", async () => {
		const ui = await start();
		await ui.click('[data-action="wizard-kind"][data-kind="temperature"]');
		await ui.type("#w-url", "ftp://device.local/api");
		await ui.click('[data-action="wizard-next"]');
		expect(ui.text()).toContain("Connection");
		await ui.type("#w-url", "http://device.local/api");
		await ui.click('[data-action="wizard-next"]');
		// The response is JSON and there is no number in the whole of it
		await ui.click('[data-action="wizard-preview"]');
		await ui.waitForText("Inconclusive response and no fallback action");
		expect(ui.text()).not.toContain("HomeKit gets");
	});

	test("can go back, and a blank device is the way out for anything else", async () => {
		const ui = await start();
		await ui.click('[data-action="wizard-kind"][data-kind="temperature"]');
		await ui.click('[data-action="wizard-back"]');
		expect(ui.text()).toContain("What is it?");

		await ui.click('[data-action="wizard-other"]');
		await waitFor(() => ui.log.forms.length === 1, "the editor");
		expect(ui.config()[0].devices).toEqual([{ name: "New device", service: "Switch", characteristics: [] }]);
		expect(ui.log.forms[0].data.name).toBe("New device");
	});

	test("the wizard is available again from the manager", async () => {
		const ui = await start({ config: [platform([sensor()])] });
		await ui.click('[data-action="wizard"]');
		expect(ui.text()).toContain("Set up a device");
		expect(ui.text()).not.toContain("Welcome");
		await ui.click('[data-action="wizard-cancel"]');
		expect(ui.text()).toContain("Air");
	});
});

describe("the manager", () => {
	const names = (ui) => ui.config()[0].devices.map((device) => device.name);

	test("lists the devices with their status", async () => {
		const ui = await start({ config: [platform([sensor(), sensor("Broken", { service: "" })])] });
		await ui.waitForText("OK");
		await ui.waitForText("1 error(s)");
		expect(ui.root.querySelectorAll("[data-device]")).toHaveLength(2);
	});

	test("copies, moves and deletes devices, asking before it deletes", async () => {
		const ui = await start({ config: [platform([sensor("A"), sensor("B")])] });

		await ui.click('[data-action="copy"][data-index="0"]');
		expect(names(ui)).toEqual(["A", "A copy", "B"]);
		expect(ui.log.updates).toHaveLength(1);

		await ui.click('[data-action="down"][data-index="0"]');
		expect(names(ui)).toEqual(["A copy", "A", "B"]);
		await ui.click('[data-action="up"][data-index="2"]');
		expect(names(ui)).toEqual(["A copy", "B", "A"]);
		expect(ui.$('[data-action="up"][data-index="0"]').disabled).toBe(true);
		expect(ui.$('[data-action="down"][data-index="2"]').disabled).toBe(true);

		await ui.click('[data-action="delete"][data-index="1"]');
		expect(names(ui)).toEqual(["A copy", "B", "A"]);
		await ui.click('[data-action="delete-cancel"][data-index="1"]');
		expect(names(ui)).toEqual(["A copy", "B", "A"]);
		await ui.click('[data-action="delete"][data-index="1"]');
		await ui.click('[data-action="delete-confirm"][data-index="1"]');
		expect(names(ui)).toEqual(["A copy", "A"]);
	});

	test("rebuilds the standard form after a change made here, when it is shown", async () => {
		const ui = await start({ config: [platform([sensor()])] });
		await ui.click('[data-action="toggle-schema"]');
		await ui.click('[data-action="copy"][data-index="0"]');
		expect(ui.log.schema.slice(-2)).toEqual(["hide", "show"]);
	});

	test("leaves the standard form alone after a change made here, when it is hidden", async () => {
		const ui = await start({ config: [platform([sensor()])] });
		await ui.click('[data-action="copy"][data-index="0"]');
		expect(ui.log.schema).toEqual([]);
	});

	test("tells a device without an identifier that renaming makes a new accessory, and can pin one", async () => {
		const ui = await start({ config: [platform([sensor("A"), sensor("B", { id: "b-1" })])] });
		await ui.click('[data-action="toggle"][data-index="1"]');
		expect(ui.text()).not.toContain("no identifier");
		await ui.click('[data-action="toggle"][data-index="0"]');
		expect(ui.text()).toContain("no identifier");

		await ui.click('[data-action="pin-id"]');
		expect(ui.config()[0].devices.map((device) => device.id)).toEqual(["A", "b-1"]);
		expect(ui.text()).not.toContain("no identifier");
	});

	test("hides and shows the standard form on request", async () => {
		const ui = await start({ config: [platform([sensor()])] });
		expect(ui.text()).toContain("Show standard form");
		await ui.click('[data-action="toggle-schema"]');
		expect(ui.log.schema.at(-1)).toBe("show");
		expect(ui.text()).toContain("Hide standard form");
		await ui.click('[data-action="toggle-schema"]');
		expect(ui.log.schema.at(-1)).toBe("hide");
	});

	test("tests a read and shows every step of the mappers", async () => {
		const ui = await start({ config: [platform([sensor()])] });
		await ui.click('[data-action="toggle"][data-index="0"]');
		await ui.click('[data-action="test-get"]');
		await ui.waitForText("HomeKit gets: 812.4");
		expect(ui.text()).toContain("jpath");
		expect(ui.text()).toContain("number");
		expect(ui.fetchCalls[0].url).toBe("http://air.local/api");
	});

	test("shows an error of a read in words", async () => {
		const ui = await start({ config: [platform([sensor()])], body: "offline" });
		await ui.click('[data-action="toggle"][data-index="0"]');
		await ui.click('[data-action="test-get"]');
		await ui.waitForText("Inconclusive response and no fallback action");
	});

	test("previews a set without sending anything", async () => {
		const ui = await start({ config: [platform([lamp()])] });
		await ui.click('[data-action="toggle"][data-index="0"]');
		await ui.type("[data-preview-value]", "true");
		await ui.click('[data-action="preview-set"]');
		await ui.waitForText("GET http://lamp.local/power?v=true");
		expect(ui.fetchCalls).toHaveLength(0);
	});

	test("turns testing off when the Homebridge UI has no login", async () => {
		const ui = await start({ config: [platform([sensor()])], formAuth: false });
		expect(ui.text()).toContain("Sending test requests is off");
		await ui.click('[data-action="toggle"][data-index="0"]');
		expect(ui.$('[data-action="test-get"]').disabled).toBe(true);
	});

	test("exports a device without its secrets", async () => {
		const ui = await start({ config: [platform([lamp()])] });
		await ui.click('[data-action="export"][data-index="0"]');
		const exported = ui.$("#export-0").value;
		expect(JSON.parse(exported).bearerToken).toBe("***");
		expect(exported).not.toContain("secret-token");
		await ui.click('[data-action="export-close"]');
		expect(ui.$("#export-0")).toBeNull();
	});

	test("does not let a device name break the page", async () => {
		const ui = await start({ config: [platform([sensor('<img src=x onerror="window.pwned=1">')])] });
		expect(ui.$("img")).toBeNull();
		expect(ui.text()).toContain("<img");
		expect(ui.window.pwned).toBeUndefined();
	});

	test("follows changes made in the standard form", async () => {
		const ui = await start({ config: [platform([sensor("A")])] });
		ui.homebridge.dispatchEvent(
			new ui.window.MessageEvent("configChanged", { data: [platform([sensor("A"), sensor("Added in form")])] })
		);
		await ui.waitForText("Added in form");
		// It is not written back: the standard form owns that change
		expect(ui.log.updates).toEqual([]);
	});

	test("a change event that is not a configuration does not empty the list", async () => {
		const ui = await start({ config: [platform([sensor("A")])] });
		for (const data of [{}, [], [{}], null, "x", { name: "no devices" }]) {
			ui.homebridge.dispatchEvent(new ui.window.MessageEvent("configChanged", { data }));
			await settle();
			await new Promise((resolve) => setTimeout(resolve, 350));
			expect(ui.root.querySelectorAll("[data-device] .card-title")[0].textContent).toBe("A");
		}
		expect(ui.log.updates).toEqual([]);
	});

	test("takes a block without its platform key, as the form of a singular platform may send", async () => {
		const ui = await start({ config: [platform([sensor("A")])] });
		ui.homebridge.dispatchEvent(
			new ui.window.MessageEvent("configChanged", {
				data: { name: "HTTP Advanced", devices: [sensor("A"), sensor("B")] },
			})
		);
		await waitFor(() => ui.root.querySelectorAll("[data-device]").length === 2, "the second device");
		expect(ui.root.querySelectorAll("[data-device]")).toHaveLength(2);
	});

	test("asks the Homebridge UI when the event says nothing usable", async () => {
		const ui = await start({ config: [platform([sensor("A")])] });
		ui.homebridge.getPluginConfig = async () => [platform([sensor("A"), sensor("From host")])];
		ui.homebridge.dispatchEvent(new ui.window.MessageEvent("configChanged", { data: {} }));
		await ui.waitForText("From host");
	});

	test("does not complain about the child bridge settings of the platform", async () => {
		const ui = await start({
			config: [platform([sensor()], { _bridge: { username: "0E:12:34:56:78:9A", port: 35000 } })],
		});
		await ui.waitForText("OK");
		expect(ui.text()).not.toContain("Problems with the platform settings");
		expect(ui.text()).not.toContain("_bridge");
	});

	test("shows cached accessories that are no longer configured", async () => {
		const pump = handlers.hapUuid("HttpAdvancedPlatform:Air");
		const ui = await start({
			config: [platform([sensor()])],
			cached: [
				{ UUID: pump, displayName: "Air" },
				{ UUID: handlers.hapUuid("HttpAdvancedPlatform:Old"), displayName: "Old" },
			],
		});
		await ui.waitForText("Accessories in HomeKit (2)");
		expect(ui.text()).toContain("not configured");
	});
});

describe("editing", () => {
	test("edits a device in the form of a single device and keeps the result", async () => {
		const ui = await start({ config: [platform([sensor("A"), sensor("B")])] });
		await ui.click('[data-action="edit"][data-index="1"]');
		await waitFor(() => ui.log.forms.length === 1, "the editor");

		const form = ui.log.forms[0];
		expect(form.schema.schema.properties.characteristics).toBeDefined();
		expect(form.data.name).toBe("B");
		expect(ui.log.schema.at(-1)).toBe("hide");
		expect(ui.text()).toContain("Editing B");
		// B has no identifier: the page says what renaming would do
		expect(ui.text()).toContain("renaming it would create a new accessory");

		await form.submitted({ ...form.data, name: "B renamed" });
		await waitFor(() => ui.log.updates.length === 1, "the update");
		expect(ui.config()[0].devices.map((device) => device.name)).toEqual(["A", "B renamed"]);
		expect(form.ended).toBe(true);
		expect(ui.log.schema).not.toContain("show");
		expect(ui.text()).toContain("B renamed");
	});

	test("takes the data from the last change when the submit has none", async () => {
		const ui = await start({ config: [platform([sensor("A")])] });
		await ui.click('[data-action="edit"][data-index="0"]');
		await waitFor(() => ui.log.forms.length === 1, "the editor");
		const form = ui.log.forms[0];
		form.change({ ...form.data, name: "From change" });
		await form.submitted(undefined);
		await waitFor(() => ui.log.updates.length === 1, "the update");
		expect(ui.config()[0].devices[0].name).toBe("From change");
	});

	test("unwraps data that arrives in an envelope", async () => {
		const ui = await start({ config: [platform([sensor("A")])] });
		await ui.click('[data-action="edit"][data-index="0"]');
		await waitFor(() => ui.log.forms.length === 1, "the editor");
		const form = ui.log.forms[0];
		await form.submitted({ data: { ...form.data, name: "Wrapped" } });
		await waitFor(() => ui.log.updates.length === 1, "the update");
		expect(ui.config()[0].devices[0].name).toBe("Wrapped");
	});

	test("the way back is at the top of every view, not only at the bottom", async () => {
		const ui = await start({ config: [platform([sensor("A")])] });

		await ui.click('[data-action="wizard"]');
		const bar = ui.root.firstElementChild;
		expect(bar.querySelector('[data-action="wizard-cancel"]')).not.toBeNull();
		expect(bar.textContent).toContain("Back to devices");
		expect(bar.textContent).toContain("Set up a device");
		await ui.click('[data-action="wizard-cancel"]');
		expect(ui.text()).toContain("Add blank device");

		await ui.click('[data-action="import"]');
		expect(ui.root.firstElementChild.querySelector('[data-action="import-cancel"]')).not.toBeNull();
		await ui.click('[data-action="import-cancel"]');

		await ui.click('[data-action="edit"][data-index="0"]');
		await waitFor(() => ui.log.forms.length === 1, "the editor");
		expect(ui.root.firstElementChild.textContent).toContain("Editing A");
		await ui.click('[data-action="edit-cancel"]');
		expect(ui.log.forms[0].ended).toBe(true);
		expect(ui.text()).toContain("Add blank device");
		expect(ui.log.updates).toEqual([]);
		expect(ui.log.schema).not.toContain("show");
	});

	test("shows how far the wizard is", async () => {
		const ui = await start();
		await ui.click('[data-action="wizard-kind"][data-kind="temperature"]');
		const bar = ui.$('[role="progressbar"]');
		expect(bar.getAttribute("aria-valuenow")).toBe("33");
		expect(ui.text()).toContain("Step 2 of 6");
	});

	test("cancelling changes nothing", async () => {
		const ui = await start({ config: [platform([sensor("A")])] });
		await ui.click('[data-action="edit"][data-index="0"]');
		await waitFor(() => ui.log.forms.length === 1, "the editor");
		ui.log.forms[0].cancelled();
		await settle();
		expect(ui.log.updates).toEqual([]);
		expect(ui.log.forms[0].ended).toBe(true);
		expect(ui.$("[data-device] .card-title").textContent).toBe("A");
		expect(ui.log.schema).not.toContain("show");
	});

	test("brings the standard form back after editing when it was shown before", async () => {
		const ui = await start({ config: [platform([sensor("A")])] });
		await ui.click('[data-action="toggle-schema"]');
		await ui.click('[data-action="edit"][data-index="0"]');
		await waitFor(() => ui.log.forms.length === 1, "the editor");
		expect(ui.log.schema.at(-1)).toBe("hide");
		ui.log.forms[0].cancelled();
		await settle();
		expect(ui.log.schema.at(-1)).toBe("show");
	});

	test("edits the defaults", async () => {
		const ui = await start({ config: [platform([sensor()], { defaults: { timeout: 5000 } })] });
		await ui.click('[data-action="edit-defaults"]');
		await waitFor(() => ui.log.forms.length === 1, "the editor");
		const form = ui.log.forms[0];
		expect(form.data).toEqual({ timeout: 5000 });
		await form.submitted({ timeout: 8000, retries: 2 });
		await waitFor(() => ui.log.updates.length === 1, "the update");
		expect(ui.config()[0].defaults).toEqual({ timeout: 8000, retries: 2 });
	});

	test("clearing the defaults removes them", async () => {
		const ui = await start({ config: [platform([sensor()], { defaults: { timeout: 5000 } })] });
		await ui.click('[data-action="edit-defaults"]');
		await waitFor(() => ui.log.forms.length === 1, "the editor");
		await ui.log.forms[0].submitted({});
		await waitFor(() => ui.log.updates.length === 1, "the update");
		expect(ui.config()[0]).not.toHaveProperty("defaults");
	});

	test("a blank device is added and opened for editing", async () => {
		const ui = await start({ config: [platform([sensor()])] });
		await ui.click('[data-action="add-blank"]');
		await waitFor(() => ui.log.forms.length === 1, "the editor");
		expect(ui.config()[0].devices.map((device) => device.name)).toEqual(["Air", "New device"]);
		expect(ui.log.forms[0].data.name).toBe("New device");
	});

	test("falls back to the standard form when the editor cannot be opened", async () => {
		const ui = await start({ config: [platform([sensor()])] });
		ui.homebridge.createForm = () => {
			throw new Error("not supported");
		};
		await ui.click('[data-action="edit"][data-index="0"]');
		await settle();
		expect(ui.log.toasts.at(-1)[0]).toBe("error");
		expect(ui.text()).toContain("Air");
		expect(ui.log.schema).not.toContain("show");
	});
});

describe("importing 1.x settings", () => {
	const accessory = {
		accessory: "HttpAdvancedAccessory",
		name: "Old lamp",
		service: "Switch",
		urls: { getOn: { url: "http://lamp.local/state" } },
	};

	test("converts pasted settings and adds the devices", async () => {
		const ui = await start({ config: [platform([sensor()])] });
		await ui.click('[data-action="import"]');
		expect(ui.log.schema.at(-1)).toBe("hide");

		await ui.type("#import-text", JSON.stringify({ accessories: [accessory] }));
		await ui.click('[data-action="import-convert"]');
		expect(ui.text()).toContain("1 device(s) found.");

		await ui.click('[data-action="import-add"]');
		await waitFor(() => ui.log.updates.length === 1, "the update");
		expect(ui.config()[0].devices.map((device) => device.name)).toEqual(["Air", "Old lamp"]);
		expect(ui.log.toasts.at(-1)).toEqual(["success", "1 device(s) added. Press Save to keep them."]);
	});

	test("says what is wrong, and can be cancelled", async () => {
		const ui = await start({ config: [platform([sensor()])] });
		await ui.click('[data-action="import"]');
		await ui.type("#import-text", "{oops");
		await ui.click('[data-action="import-convert"]');
		expect(ui.text()).toContain("not valid JSON");
		expect(ui.$('[data-action="import-add"]')).toBeNull();

		await ui.click('[data-action="import-cancel"]');
		expect(ui.text()).toContain("Air");
		expect(ui.log.updates).toEqual([]);
		expect(ui.log.schema).not.toContain("show");
	});
});

describe("language", () => {
	test("speaks Traditional Chinese when the Homebridge UI does", async () => {
		const ui = await start({ config: [platform([sensor()])], lang: "zh-TW" });
		expect(ui.text()).toContain("新增裝置（精靈）");
		expect(ui.window.document.documentElement.lang).toBe("zh-TW");
	});

	test("shows the wizard in Traditional Chinese", async () => {
		const ui = await start({ lang: "zh-TW" });
		expect(ui.text()).toContain("設定裝置");
		expect(ui.text()).toContain("溫度感測器");
	});

	test("speaks English for a language it does not have", async () => {
		const ui = await start({ config: [platform([sensor()])], lang: "fr" });
		expect(ui.text()).toContain("Add device (wizard)");
	});
});
