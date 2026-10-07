const schema = require("../config.schema.json");

test("targets the registered accessory", () => {
	expect(schema.pluginAlias).toBe("HttpAdvancedAccessory");
	expect(schema.pluginType).toBe("accessory");
});

test("describes every setting the plugin reads", () => {
	expect(Object.keys(schema.schema.properties).sort()).toEqual(
		[
			"name",
			"service",
			"optionCharacteristic",
			"props",
			"forceRefreshDelay",
			"setterDelay",
			"debug",
			"username",
			"password",
			"bearerToken",
			"immediately",
			"timeout",
			"retries",
			"cacheTTL",
			"maxConcurrent",
			"uriCallsDelay",
			"urls",
		].sort()
	);
});
