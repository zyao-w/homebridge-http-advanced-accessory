const HttpAdvancedAccessory = require("./accessory.js");

module.exports = function (homebridge) {
	homebridge.registerAccessory("homebridge-http-advanced-accessory-zyao", "HttpAdvancedAccessory", HttpAdvancedAccessory);
};
