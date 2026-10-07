const HttpAdvancedPlatform = require("../src/platform.js");
const { PLUGIN_NAME, PLATFORM_NAME } = require("../src/constants.js");

test("registers the platform and no accessory", () => {
	const homebridge = { registerPlatform: jest.fn(), registerAccessory: jest.fn() };
	require("../src/index.js")(homebridge);

	expect(homebridge.registerPlatform).toHaveBeenCalledWith(PLUGIN_NAME, PLATFORM_NAME, HttpAdvancedPlatform);
	expect(homebridge.registerAccessory).not.toHaveBeenCalled();
});
