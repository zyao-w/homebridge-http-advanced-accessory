const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
	{ ignores: ["node_modules/", ".homebridge-dev/", "HomeKitExtensionTypes.js"] },
	js.configs.recommended,
	{
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: "commonjs",
			globals: { ...globals.node },
		},
		// Arguments such as `value` and `state` are read by eval'd expressions
		rules: {
			"no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
		},
	},
	{
		files: ["**/*.test.js"],
		languageOptions: { globals: { ...globals.jest } },
	},
	{
		// The pages of the custom UI run in the browser; the pure modules also run in Node for the tests
		files: ["homebridge-ui/public/**/*.js"],
		languageOptions: { sourceType: "script", globals: { ...globals.browser, module: "readonly" } },
	},
];
