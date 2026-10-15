// Server side of the custom UI of the Homebridge settings page. The Homebridge UI starts it when the settings of the
// plugin are opened and stops it when they are closed. The logic is in src/ui-handlers.js.
const handlers = require("../src/ui-handlers.js");

async function main() {
	// @homebridge/plugin-ui-utils is an ES module; import() loads it on every Node.js version that the plugin supports
	const { HomebridgePluginUiServer } = await import("@homebridge/plugin-ui-utils");

	class HttpAdvancedUiServer extends HomebridgePluginUiServer {
		constructor() {
			// this must be called first
			super();

			// Read at every request, so that a change of the login setting applies without reopening the settings
			const authDisabled = () => handlers.isUiAuthDisabled(this.homebridgeConfigPath);
			const testGet = handlers.createTestGet({
				get authDisabled() {
					return authDisabled();
				},
			});

			this.onRequest("/info", () => ({ testsDisabled: authDisabled() }));
			this.onRequest("/validate", (payload) => handlers.validate(payload));
			this.onRequest("/test-get", (payload) => testGet(payload));
			this.onRequest("/preview-set", (payload) => handlers.previewSet(payload));
			this.onRequest("/import-1x", (payload) => handlers.importLegacy(payload));
			this.onRequest("/cached", (payload) => handlers.cachedStatus(payload));
			this.onRequest("/device-schema", (payload) => handlers.deviceSchema(payload));
			this.onRequest("/defaults-schema", () => handlers.defaultsSchema());

			// this must be called to tell the Homebridge UI that requests can be sent
			this.ready();
		}
	}

	return new HttpAdvancedUiServer();
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
