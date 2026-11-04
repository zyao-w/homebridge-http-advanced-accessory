// Changes to the plugin configuration for the manager page of the custom UI. Pure functions: they never modify what
// they are given and return a new list of config blocks, which is what the Homebridge UI hands out and takes back.
// The file runs in the browser and in Node (for the tests).
(function (root, factory) {
	const api = factory();
	if (typeof module === "object" && module.exports) module.exports = api;
	else root.HttpAdvancedConfig = api;
})(typeof self !== "undefined" ? self : this, function () {
	const PLATFORM = "HttpAdvancedPlatform";
	const DEFAULT_NAME = "HTTP Advanced";
	const MASK = "***";
	// A reference to a secret is not a secret, so it stays readable when a device is exported
	const REFERENCE = /^\s*(env|file):/;

	const clone = (value) => JSON.parse(JSON.stringify(value));
	const isPlatform = (block) => Boolean(block) && block.platform === PLATFORM;

	/** The platform block, or undefined while the plugin is not configured. */
	function findPlatform(blocks) {
		return (Array.isArray(blocks) ? blocks : []).find(isPlatform);
	}

	/**
	 * The list of config blocks in what the Homebridge UI hands out, or null when it is not the configuration of
	 * this plugin. A list needs a platform block of this plugin; a single block is accepted with or without its
	 * `platform` key. An empty list, an empty object or anything else is not taken for a configuration, so a form
	 * that has not loaded yet cannot empty the page.
	 */
	function blocksFrom(data) {
		if (Array.isArray(data)) return data.some(isPlatform) ? data : null;
		if (!data || typeof data !== "object") return null;
		if (isPlatform(data)) return [data];
		return Array.isArray(data.devices) ? [{ platform: PLATFORM, ...data }] : null;
	}

	function devicesOf(blocks) {
		const platform = findPlatform(blocks);
		return platform && Array.isArray(platform.devices) ? platform.devices : [];
	}

	function defaultsOf(blocks) {
		const platform = findPlatform(blocks);
		return platform && platform.defaults && typeof platform.defaults === "object" ? platform.defaults : {};
	}

	/** Applies `change` to a copy of the platform block, which is created when there is none yet. */
	function update(blocks, change) {
		const list = Array.isArray(blocks) ? blocks.map(clone) : [];
		let index = list.findIndex(isPlatform);
		if (index < 0) {
			list.push({ platform: PLATFORM, name: DEFAULT_NAME });
			index = list.length - 1;
		}
		const platform = list[index];
		platform.devices = Array.isArray(platform.devices) ? platform.devices : [];
		change(platform);
		return list;
	}

	/** "Lamp" becomes "Lamp copy", then "Lamp copy 2", for the first one that is not taken. */
	function uniqueName(base, taken) {
		const names = new Set(taken);
		const stem = `${base} copy`;
		if (!names.has(stem)) return stem;
		for (let n = 2; ; n++) {
			if (!names.has(`${stem} ${n}`)) return `${stem} ${n}`;
		}
	}

	/** A name that is not in use: the name itself when it is free, otherwise the name with a number. */
	function freeName(base, taken) {
		const names = new Set(taken);
		if (!names.has(base)) return base;
		for (let n = 2; ; n++) {
			if (!names.has(`${base} ${n}`)) return `${base} ${n}`;
		}
	}

	const nameOf = (device) => (device && typeof device.name === "string" ? device.name : "");
	const idOf = (device) => (device && typeof device.id === "string" && device.id ? device.id : nameOf(device));

	/** A device that does not clash with the others by name or id. */
	function uniqueDevice(device, existing) {
		const copy = clone(device);
		const names = existing.map(nameOf);
		const ids = existing.map(idOf);
		if (names.includes(copy.name) || ids.includes(idOf(copy))) {
			copy.name = freeName(nameOf(copy) || "Device", names);
		}
		if (typeof copy.id === "string" && copy.id && ids.includes(copy.id)) {
			copy.id = freeName(copy.id, ids);
		}
		if (ids.includes(idOf(copy))) {
			copy.name = freeName(nameOf(copy) || "Device", [...names, ...ids]);
		}
		return copy;
	}

	function addDevice(blocks, device) {
		return update(blocks, (platform) => {
			platform.devices.push(uniqueDevice(device, platform.devices));
		});
	}

	function addDevices(blocks, devices) {
		return update(blocks, (platform) => {
			for (const device of devices) platform.devices.push(uniqueDevice(device, platform.devices));
		});
	}

	function replaceDevice(blocks, index, device) {
		return update(blocks, (platform) => {
			if (index >= 0 && index < platform.devices.length) platform.devices[index] = clone(device);
		});
	}

	function removeDevice(blocks, index) {
		return update(blocks, (platform) => {
			if (index >= 0 && index < platform.devices.length) platform.devices.splice(index, 1);
		});
	}

	/** Moves a device by `offset` places (-1 up, 1 down); stays put at the ends of the list. */
	function moveDevice(blocks, index, offset) {
		return update(blocks, (platform) => {
			const target = index + offset;
			if (index < 0 || index >= platform.devices.length || target < 0 || target >= platform.devices.length) return;
			const [device] = platform.devices.splice(index, 1);
			platform.devices.splice(target, 0, device);
		});
	}

	/** A copy right below the original. The copy gets its own name, and its own id if the original has one. */
	function duplicateDevice(blocks, index) {
		return update(blocks, (platform) => {
			const original = platform.devices[index];
			if (!original) return;
			const copy = clone(original);
			copy.name = uniqueName(nameOf(original) || "Device", platform.devices.map(nameOf));
			if (typeof copy.id === "string" && copy.id) {
				copy.id = uniqueName(copy.id, platform.devices.map(idOf));
			}
			platform.devices.splice(index + 1, 0, copy);
		});
	}

	/** Replaces the platform `defaults`; an empty object removes them. */
	function setDefaults(blocks, defaults) {
		return update(blocks, (platform) => {
			if (defaults && Object.keys(defaults).length > 0) platform.defaults = clone(defaults);
			else delete platform.defaults;
		});
	}

	/** Gives a device a permanent id equal to its name, so that it can be renamed without becoming a new accessory. */
	function pinId(blocks, index) {
		return update(blocks, (platform) => {
			const device = platform.devices[index];
			if (device && !(typeof device.id === "string" && device.id)) device.id = nameOf(device);
		});
	}

	function summarize(device) {
		const own = Array.isArray(device && device.characteristics) ? device.characteristics.length : 0;
		const extras = Array.isArray(device && device.additionalServices) ? device.additionalServices : [];
		return {
			name: nameOf(device),
			id: device && typeof device.id === "string" ? device.id : "",
			service: device && typeof device.service === "string" ? device.service : "",
			characteristics: own + extras.reduce((sum, extra) => sum + ((extra && extra.characteristics) || []).length, 0),
			additionalServices: extras.length,
		};
	}

	/**
	 * Every characteristic of a device that has a get or a set action, for the test buttons.
	 * `service` is the id of an additional service, empty for the service of the device.
	 */
	function actionsOf(device) {
		const found = [];
		const collect = (service, entries) => {
			for (const entry of Array.isArray(entries) ? entries : []) {
				if (!entry || typeof entry.characteristic !== "string") continue;
				found.push({
					service,
					characteristic: entry.characteristic,
					get: Boolean(entry.get && entry.get.url),
					set: Boolean(entry.set && entry.set.url),
				});
			}
		};
		collect("", device && device.characteristics);
		for (const extra of Array.isArray(device && device.additionalServices) ? device.additionalServices : []) {
			if (extra && typeof extra.id === "string") collect(extra.id, extra.characteristics);
		}
		return found;
	}

	// Only the headers have a "value" among the settings, so every setting with these names can hold a secret
	function mask(node, key) {
		if (Array.isArray(node)) return node.map((item) => mask(item));
		if (node && typeof node === "object") {
			const result = {};
			for (const [name, value] of Object.entries(node)) result[name] = mask(value, name);
			return result;
		}
		const secret = key === "bearerToken" || key === "password" || key === "value";
		return secret && typeof node === "string" && node !== "" && !REFERENCE.test(node) ? MASK : node;
	}

	/** The device as text for an issue or a message: secrets are masked, references like env:NAME stay. */
	function exportDevice(device) {
		return JSON.stringify(mask(clone(device)), null, 2);
	}

	return {
		PLATFORM,
		findPlatform,
		blocksFrom,
		devicesOf,
		defaultsOf,
		addDevice,
		addDevices,
		replaceDevice,
		removeDevice,
		moveDevice,
		duplicateDevice,
		setDefaults,
		pinId,
		summarize,
		actionsOf,
		exportDevice,
		uniqueName,
		freeName,
	};
});
