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
		// Legacy patterns in index.js; revisit in the structure refactor (phase 3)
		rules: {
			"no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
			"no-redeclare": "warn",
			"no-prototype-builtins": "warn",
		},
	},
	{
		files: ["**/*.test.js"],
		languageOptions: { globals: { ...globals.jest } },
	},
];
