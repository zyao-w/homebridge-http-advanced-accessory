const { JSONPath } = require("jsonpath-plus");
const { INCONCLUSIVE } = require("./constants.js");

/** Selects a value from a JSON document with a JSONPath expression. */
class JPathMapper {
	constructor(parameters) {
		this.jpath = parameters.jpath;
		this.index = parameters.index || 0;
	}

	map(value) {
		let json;
		try {
			json = JSON.parse(value);
		} catch (e) {
			return INCONCLUSIVE;
		}

		if (typeof json !== "object" || json === null) {
			return INCONCLUSIVE;
		}

		let result = JSONPath({ path: this.jpath, json: json });
		if (Array.isArray(result) && result.length > this.index) {
			result = result[this.index];
		}
		if (result instanceof Object) {
			result = JSON.stringify(result);
		}

		return result;
	}
}

module.exports = JPathMapper;
