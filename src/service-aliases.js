// HAP-NodeJS renamed a few services and kept the old names as deprecated aliases in the 0.x line, and Homebridge 2.x
// has only the new ones. The new names exist in both, so the form offers them; a configuration that still has an old
// name keeps working through this table.
const SERVICE_ALIASES = {
	BatteryService: "Battery",
	CameraEventRecordingManagement: "CameraRecordingManagement",
	Relay: "CloudRelay",
	Slat: "Slats",
	TunneledBTLEAccessoryService: "Tunnel",
};

const REVERSE = Object.fromEntries(Object.entries(SERVICE_ALIASES).map(([from, to]) => [to, from]));

/** The name that the form and the lists use for a service: the new name when an old one was written. */
function currentServiceName(name) {
	return Object.prototype.hasOwnProperty.call(SERVICE_ALIASES, name) ? SERVICE_ALIASES[name] : name;
}

/**
 * Looks a service class up in `hap.Service` by the name written in the configuration, or by its other name when the
 * HAP-NodeJS of this Homebridge has only that one.
 * @returns {Function|undefined}
 */
function findService(Service, name) {
	for (const candidate of [name, SERVICE_ALIASES[name], REVERSE[name]]) {
		if (typeof candidate !== "string" || !Object.prototype.hasOwnProperty.call(Service, candidate)) continue;
		if (typeof Service[candidate] === "function") return Service[candidate];
	}
	return undefined;
}

module.exports = { SERVICE_ALIASES, currentServiceName, findService };
