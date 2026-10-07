#!/usr/bin/env node
// Regenerates config.schema.json from src/schema.js
const fs = require("fs");
const path = require("path");
const { buildSchema } = require("../src/schema.js");

fs.writeFileSync(path.join(__dirname, "..", "config.schema.json"), JSON.stringify(buildSchema(), null, 2) + "\n");
