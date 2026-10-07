const HttpAdvancedAccessory = require("./accessory.js");
const HttpAdvancedPlatform = require("./platform.js");
const { PLUGIN_NAME, ACCESSORY_NAME, PLATFORM_NAME } = require("./constants.js");

module.exports = function (homebridge) {
	homebridge.registerAccessory(PLUGIN_NAME, ACCESSORY_NAME, HttpAdvancedAccessory);
	homebridge.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, HttpAdvancedPlatform);
};
