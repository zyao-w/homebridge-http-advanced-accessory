const crypto = require("node:crypto");
const fs = require("node:fs");
const HttpClient = require("./http/client.js");
const ActionRunner = require("./runner.js");
const { INCONCLUSIVE } = require("./mappers/index.js");
const { migrateConfig } = require("./migrate.js");
const { prepareDevice } = require("./prepare-device.js");
const { suggestPaths } = require("./suggest.js");
const { renderTemplate } = require("./template.js");
const { validatePlatform } = require("./validate.js");
const { buildDeviceFormSchema, buildDefaultsFormSchema } = require("./schema.js");
const { SERVICES } = require("./hap-names.js");
const { currentServiceName } = require("./service-aliases.js");
const { PLATFORM_NAME } = require("./constants.js");

// The custom UI of the Homebridge settings page calls these through homebridge-ui/server.js. They are plain functions
// so that they can be tested without the Homebridge UI.

const MAX_BODY = 4000;
const MAX_VALUE = 300;
const MAX_TIMEOUT = 30000;
const DEFAULT_TIMEOUT = 10000;

const shown = (value) => {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	const cut = String(text).length > MAX_VALUE;
	return cut ? String(text).slice(0, MAX_VALUE) + "…" : String(text);
};

/** The platform block of what getPluginConfig() returns (a list of blocks), or of a single block. */
function platformBlock(config) {
	const blocks = Array.isArray(config) ? config : config ? [config] : [];
	return blocks.find((block) => block && block.platform === PLATFORM_NAME) || null;
}

const deviceId = (device) => (typeof device.id === "string" && device.id ? device.id : device.name);

/** The same identifier that HAP-NodeJS `uuid.generate` makes, which names the accessory in the Homebridge cache. */
function hapUuid(data) {
	const hash = crypto.createHash("sha1").update(data).digest("hex");
	let i = -1;
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
		i += 1;
		return c === "y" ? ((parseInt(hash[i], 16) & 0x3) | 0x8).toString(16) : hash[i];
	});
}

const accessoryUuid = (device) => hapUuid(`${PLATFORM_NAME}:${deviceId(device)}`);

/**
 * Whether the Homebridge UI asks for no login. Then anybody on the network can use the settings page, which is
 * why the UI does not offer requests to arbitrary URLs from it.
 */
function isUiAuthDisabled(configPath) {
	try {
		const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
		return (config.platforms || []).some(
			(platform) => platform && platform.platform === "config" && platform.auth === "none"
		);
	} catch {
		return false;
	}
}

/**
 * Reports what the plugin would do with the configuration, in the words of its log.
 * @returns {{platform: string[], devices: Array<{index: number, name: string, errors: string[], warnings: string[], characteristics: number}>}}
 */
function validate({ config } = {}) {
	const block = platformBlock(config);
	if (!block) return { platform: [], devices: [] };

	const platform = validatePlatform(block);
	const defaults = block.defaults && typeof block.defaults === "object" ? block.defaults : {};
	const rawDevices = Array.isArray(block.devices) ? block.devices : [];
	const used = new Map();
	const results = [];

	rawDevices.forEach((raw, index) => {
		const name = raw && typeof raw.name === "string" ? raw.name : "";
		const result = { index, name, errors: [], warnings: [], characteristics: 0 };
		results.push(result);

		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			result.errors.push("is not an object");
			return;
		}

		const prepared = prepareDevice(raw, defaults, { warn: (message) => result.warnings.push(message) });
		result.errors.push(...prepared.validationErrors);
		if (prepared.error) result.errors.push(prepared.error.message);
		if (prepared.device) {
			result.characteristics =
				prepared.device.characteristics.length +
				prepared.device.additionalServices.reduce((sum, extra) => sum + extra.characteristics.length, 0);
			if (prepared.device.authError) result.warnings.push(prepared.device.authError.message);
		}
		if (!prepared.device) return;

		const id = deviceId(prepared.device);
		if (used.has(id)) {
			const first = results[used.get(id)];
			result.errors.push(`has the same identifier as "${first.name}", give it a unique "id"`);
		} else {
			used.set(id, index);
		}
	});

	return { platform, devices: results };
}

function findCharacteristic(device, serviceId, name) {
	const service = serviceId ? device.additionalServices.find((extra) => extra.id === serviceId) : device;
	if (!service) return null;
	return service.characteristics.find((entry) => entry.name === name) || null;
}

function mapperName(mapper) {
	return mapper.constructor.name.replace(/Mapper$/, "").toLowerCase();
}

function checkUrl(url) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		return "The URL is not valid";
	}
	return parsed.protocol === "http:" || parsed.protocol === "https:" ? null : "Only http and https URLs can be tested";
}

/** Runs one read action step by step, following the fallback, and returns what happened at every step. */
async function runRead(runner, action) {
	const problem = checkUrl(action.url);
	if (problem) return { ok: false, error: problem, steps: [] };

	let response;
	try {
		response = await runner.readRequest(action, { fresh: true });
	} catch (error) {
		if (action.resultOnError != null) {
			return {
				ok: true,
				usedResultOnError: true,
				error: error.message,
				status: error.status,
				value: shown(action.resultOnError),
				steps: [],
			};
		}
		return { ok: false, error: error.message, status: error.status, steps: [] };
	}

	const result = {
		ok: true,
		status: response.status,
		body: response.body.slice(0, MAX_BODY),
		truncated: response.body.length > MAX_BODY,
		steps: [],
	};

	let value = response.body;
	for (const mapper of action.mappers || []) {
		try {
			const output = mapper.map(value);
			result.steps.push({ type: mapperName(mapper), input: shown(value), output: shown(output) });
			value = output;
		} catch (error) {
			result.steps.push({ type: mapperName(mapper), input: shown(value), error: error.message });
			return { ...result, ok: false, error: `A ${mapperName(mapper)} mapper failed: ${error.message}` };
		}
	}

	if (value == INCONCLUSIVE) {
		if (!action.inconclusive) {
			return { ...result, ok: false, inconclusive: true, error: "Inconclusive response and no fallback action" };
		}
		const fallback = await runRead(runner, action.inconclusive);
		return { ...result, ok: fallback.ok, inconclusive: true, fallback, value: fallback.value, error: fallback.error };
	}

	return { ...result, value: shown(value), valueType: typeof value };
}

function prepare(payload) {
	const defaults = payload.defaults && typeof payload.defaults === "object" ? payload.defaults : {};
	if (!payload.device || typeof payload.device !== "object") {
		return { error: "There is no device to test" };
	}
	const prepared = prepareDevice(payload.device, defaults);
	if (prepared.validationErrors.length) return { error: prepared.validationErrors.join("; ") };
	if (prepared.error) return { error: prepared.error.message };
	return { device: prepared.device };
}

/**
 * Sends the get action of a characteristic and shows the response and the result of every mapper.
 * It is the code path of the plugin itself (same client, authentication, headers and mappers).
 *
 * @param {{authDisabled?: boolean, fetch?: Function}} [environment]
 */
function createTestGet(environment = {}) {
	return async function testGet(payload = {}) {
		if (environment.authDisabled || payload.uiAuth === "none") {
			return {
				ok: false,
				disabled: true,
				error: "Testing requests is off because the Homebridge UI has no login",
			};
		}

		const { device, error } = prepare(payload);
		if (error) return { ok: false, error };

		const entry = findCharacteristic(device, payload.service, payload.characteristic);
		if (!entry || !entry.get) {
			return { ok: false, error: `${payload.characteristic || "The characteristic"} has no get action` };
		}

		const timeout = device.http.timeout > 0 ? Math.min(device.http.timeout, MAX_TIMEOUT) : DEFAULT_TIMEOUT;
		const client = new HttpClient({
			auth: device.auth,
			...device.http,
			timeout,
			retries: 0,
			cacheTTL: 0,
			fetch: environment.fetch,
		});
		const runner = new ActionRunner({ client, log: () => {}, debug: false, authError: device.authError });

		const result = await runRead(runner, entry.get);
		if (typeof result.body === "string") {
			Object.assign(result, suggestPaths(result.body));
		}
		return result;
	};
}

function parseValue(text) {
	if (typeof text !== "string") return text;
	if (text === "true") return true;
	if (text === "false") return false;
	return text.trim() !== "" && Number.isFinite(Number(text)) ? Number(text) : text;
}

/** Shows what a set action would send for a value, without sending anything. */
function previewSet(payload = {}) {
	const { device, error } = prepare(payload);
	if (error) return { ok: false, error };

	const entry = findCharacteristic(device, payload.service, payload.characteristic);
	if (!entry || !entry.set) {
		return { ok: false, error: `${payload.characteristic || "The characteristic"} has no set action` };
	}

	const action = entry.set;
	const runner = new ActionRunner({ client: null, log: () => {}, debug: false });
	const value = parseValue(payload.value);
	try {
		const mappedValue = runner.applyMappers(action.mappers, value);
		if (mappedValue === INCONCLUSIVE) {
			return { ok: false, error: `The mappers could not convert the value ${shown(value)}, nothing would be sent` };
		}
		const scope = { value, state: device.state, mappedValue };
		const unsafe = device.allowUnsafeEval;
		return {
			ok: true,
			method: action.httpMethod,
			url: renderTemplate(action.url, scope, { unsafe }),
			body: action.body ? renderTemplate(action.body, scope, { unsafe }) : "",
			value: shown(value),
			mappedValue: shown(mappedValue),
		};
	} catch (problem) {
		return { ok: false, error: problem.message };
	}
}

/** Converts a pasted 1.x configuration (a whole config.json, a list of accessories or a single accessory). */
function importLegacy({ config } = {}) {
	let input = config;
	if (typeof input === "string") {
		try {
			input = JSON.parse(input);
		} catch (error) {
			return { ok: false, error: `This is not valid JSON: ${error.message}` };
		}
	}
	if (Array.isArray(input)) {
		input = { accessories: input };
	} else if (input && typeof input === "object" && input.accessory !== undefined && input.accessories === undefined) {
		input = { accessories: [input] };
	}
	if (!input || typeof input !== "object") {
		return { ok: false, error: "There is nothing to import" };
	}

	const { config: migrated, warnings, migrated: count } = migrateConfig(input);
	const block = platformBlock(migrated.platforms);
	if (!block || count === 0) {
		return { ok: false, error: "No HttpAdvancedAccessory was found in it" };
	}
	return { ok: true, devices: block.devices, warnings, migrated: count };
}

/**
 * Compares the accessories that Homebridge has cached for the plugin with the configured devices.
 * @param {{config: *, cached: Array<{UUID: string, displayName: string}>}} payload
 */
function cachedStatus({ config, cached } = {}) {
	const block = platformBlock(config);
	const devices = block && Array.isArray(block.devices) ? block.devices : [];
	const configured = new Set(
		devices.filter((device) => device && typeof device.name === "string" && device.name).map(accessoryUuid)
	);
	const list = Array.isArray(cached) ? cached : [];
	const known = new Set(list.map((accessory) => accessory.UUID || accessory.uuid));

	// The Homebridge UI reads the cache of the main bridge and of every child bridge, so an accessory that was cached
	// before the plugin moved to a child bridge shows up twice. It is one accessory with `copies` entries.
	const accessories = new Map();
	for (const accessory of list) {
		const uuid = accessory.UUID || accessory.uuid;
		const entry = accessories.get(uuid);
		if (entry) entry.copies += 1;
		else
			accessories.set(uuid, { uuid, displayName: accessory.displayName, configured: configured.has(uuid), copies: 1 });
	}

	return {
		accessories: [...accessories.values()],
		// Devices that HomeKit has not seen yet; they are created at the next start
		pending: devices
			.filter((device) => device && typeof device.name === "string" && device.name)
			.filter((device) => !known.has(accessoryUuid(device)))
			.map((device) => device.name),
	};
}

const names = (entries) =>
	(Array.isArray(entries) ? entries : []).filter((name) => typeof name === "string" && name !== "");
const sorted = (set) => [...new Set(set)].sort((a, b) => a.localeCompare(b, "en"));

/**
 * The characteristics that a service can have, or null when its type is not one that HomeKit has (a name that is
 * typed in, or a service that is not chosen yet), in which case every name stays on offer.
 * @returns {{all: string[], optional: string[]}|null}
 */
function characteristicsOf(serviceType) {
	const service = Object.prototype.hasOwnProperty.call(SERVICES, currentServiceName(serviceType))
		? SERVICES[currentServiceName(serviceType)]
		: null;
	return service ? { all: [...service.required, ...service.optional], optional: service.optional } : null;
}

/**
 * The names to offer in the form of one device: the characteristics of its service, and those of its additional
 * services. A name that the device already uses is kept in its list, so that what is set never disappears from the
 * form, and a service that is not known leaves every name on offer.
 */
function namesForDevice(device) {
	const own = device && typeof device === "object" ? device : {};
	const extras = (Array.isArray(own.additionalServices) ? own.additionalServices : []).filter(
		(extra) => extra && typeof extra === "object"
	);
	const used = (service) => names((service.characteristics || []).map((entry) => entry && entry.characteristic));

	const lists = {};
	const main = characteristicsOf(own.service);
	if (main) {
		lists.characteristic = sorted([...main.all, ...used(own)]);
		lists.option = sorted([...main.optional, ...names(own.optionCharacteristic)]);
	}

	// All additional services share one list, since the form describes them with one set of fields. It is the names
	// of all their services together, and every name stays on offer while one of them has no known service.
	const known = extras.map((extra) => characteristicsOf(extra.service));
	if (extras.length > 0 && known.every(Boolean)) {
		lists.extraCharacteristic = sorted([...known.flatMap((one) => one.all), ...extras.flatMap(used)]);
		lists.extraOption = sorted([
			...known.flatMap((one) => one.optional),
			...extras.flatMap((extra) => names(extra.optionCharacteristic)),
		]);
	}
	return lists;
}

/** The form of one device, with the characteristics that fit the service that the device has now. */
const deviceSchema = (payload) => buildDeviceFormSchema(namesForDevice(payload && payload.device));
const defaultsSchema = () => buildDefaultsFormSchema();

module.exports = {
	validate,
	createTestGet,
	previewSet,
	importLegacy,
	cachedStatus,
	deviceSchema,
	defaultsSchema,
	isUiAuthDisabled,
	platformBlock,
	hapUuid,
};
