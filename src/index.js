const HttpAdvancedPlatform = require("./platform.js");
const { PLUGIN_NAME, PLATFORM_NAME } = require("./constants.js");

module.exports = function (homebridge) {
	homebridge.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, HttpAdvancedPlatform);
};
