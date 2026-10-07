#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { migrateConfig } = require("../src/migrate.js");

const USAGE = `Usage: node scripts/migrate-config.js <config.json> [output.json]

Converts the HttpAdvancedAccessory accessories of a Homebridge config.json into
one HttpAdvancedPlatform block. The result goes to stdout, or to output.json.
The input file is never modified; warnings are printed to stderr.`;

function main(args) {
	const [input, output] = args;

	if (!input || input === "--help" || input === "-h") {
		console.error(USAGE);
		return input ? 0 : 1;
	}

	let config;
	try {
		config = JSON.parse(fs.readFileSync(input, "utf8"));
	} catch (error) {
		console.error(`Cannot read ${input}: ${error.message}`);
		return 1;
	}

	if (output && path.resolve(output) === path.resolve(input)) {
		console.error("The output must be a different file than the input.");
		return 1;
	}

	// Accept a single accessory or a list of them as well as a whole config.json
	if (Array.isArray(config)) {
		config = { accessories: config };
	} else if (config && config.accessory !== undefined && config.accessories === undefined) {
		config = { accessories: [config] };
	}

	const { config: migrated, warnings, migrated: count } = migrateConfig(config);
	const text = JSON.stringify(migrated, null, 4) + "\n";

	if (output) {
		fs.writeFileSync(output, text);
	} else {
		process.stdout.write(text);
	}

	for (const warning of warnings) {
		console.error("WARNING: " + warning);
	}
	console.error(`Migrated ${count} accessor${count === 1 ? "y" : "ies"} with ${warnings.length} warning(s).`);
	return 0;
}

process.exitCode = main(process.argv.slice(2));
