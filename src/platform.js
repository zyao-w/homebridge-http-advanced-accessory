const DeviceController = require("./device.js");
const { normalizeDevice } = require("./device-config.js");
const { PLUGIN_NAME, PLATFORM_NAME } = require("./constants.js");
const { validateDevice, validatePlatform } = require("./validate.js");

/** Dynamic platform: one accessory per entry of `devices`, restored from the Homebridge cache. */
class HttpAdvancedPlatform {
	/**
	 * @param {Function} log Homebridge logger
	 * @param {Object} config The platform block of config.json
	 * @param {Object} api Homebridge API
	 */
	constructor(log, config, api) {
		this.log = log;
		this.config = config || {};
		this.api = api;
		this.cached = new Map();
		this.controllers = [];

		api.on("didFinishLaunching", () => this.discover());
		api.on("shutdown", () => this.controllers.forEach((controller) => controller.stop()));
	}

	/** Called by Homebridge for every accessory it restores from its cache. */
	configureAccessory(accessory) {
		this.cached.set(accessory.UUID, accessory);
	}

	_uuid(device) {
		const id = typeof device.id === "string" && device.id ? device.id : device.name;
		return this.api.hap.uuid.generate(`${PLATFORM_NAME}:${id}`);
	}

	/** Builds the accessories of the configured devices and reconciles them with the cache. */
	discover() {
		for (const problem of validatePlatform(this.config)) {
			this.log.error("Platform configuration: " + problem);
		}

		const defaults = this.config.defaults || {};
		const rawDevices = Array.isArray(this.config.devices) ? this.config.devices : [];

		const seen = new Set();
		const loaded = new Set();
		const register = [];
		const update = [];

		for (const raw of rawDevices) {
			const label = raw && typeof raw.name === "string" ? `Device "${raw.name}"` : "A device";

			// A device that cannot be loaded keeps its cached accessory so that a typo does not remove it from HomeKit
			if (raw && typeof raw.name === "string" && raw.name) {
				seen.add(this._uuid(raw));
			}

			const result = this._load(raw, defaults, label, loaded);
			if (!result) {
				continue;
			}

			const { device, accessory, controller, isNew } = result;
			(isNew ? register : update).push(accessory);
			this.controllers.push(controller);
			const extras = device.additionalServices.length;
			const count =
				device.characteristics.length + device.additionalServices.reduce((sum, e) => sum + e.characteristics.length, 0);
			this.log(
				`Configured ${label}${isNew ? "" : " (restored from cache)"} with ${count} characteristic(s)${extras ? ` and ${extras} additional service(s)` : ""}`
			);
		}

		const stale = [...this.cached.values()].filter((accessory) => !seen.has(accessory.UUID));
		if (register.length) this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, register);
		if (update.length) this.api.updatePlatformAccessories(update);
		if (stale.length) {
			for (const accessory of stale) this.log(`Removing "${accessory.displayName}", it is no longer configured`);
			this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
		}
	}

	_load(raw, defaults, label, loaded) {
		if (!raw || typeof raw !== "object") {
			this.log.error(`${label} is not an object`);
			return null;
		}

		const merged = { ...defaults, ...raw };
		// A device adds to the headers of the defaults instead of replacing them; a wrong type is left for the validation
		if (Array.isArray(defaults.headers) && Array.isArray(raw.headers)) {
			merged.headers = [...defaults.headers, ...raw.headers];
		}
		const { device: coerced, errors } = validateDevice(merged);
		if (errors.length) {
			for (const error of errors) this.log.error(`${label}: ${error}`);
			return null;
		}

		let device;
		try {
			device = normalizeDevice(coerced, {}, { warn: (message) => this.log("WARNING: " + message) });
		} catch (error) {
			this.log.error(error.message);
			return null;
		}

		const uuid = this._uuid(device);
		if (loaded.has(uuid)) {
			this.log.error(`${label} has the same identifier as another device, give it a unique "id"`);
			return null;
		}
		loaded.add(uuid);

		const cachedAccessory = this.cached.get(uuid);
		const accessory = cachedAccessory || new this.api.platformAccessory(device.name, uuid);
		const deviceLog = (message, ...args) => this.log(`[${device.name}] ${message}`, ...args);
		const controller = new DeviceController({ device, accessory, api: this.api, log: deviceLog });

		try {
			controller.start();
		} catch (error) {
			controller.stop();
			this.log.error(error.message);
			return null;
		}

		return { device, accessory, controller, isNew: !cachedAccessory };
	}
}

module.exports = HttpAdvancedPlatform;
