const StaticMapper = require("./static.js");
const RegexMapper = require("./regex.js");
const XPathMapper = require("./xpath.js");
const JPathMapper = require("./jpath.js");
const EvalMapper = require("./eval.js");
const ExpressionMapper = require("./expression.js");
const { INCONCLUSIVE } = require("./constants.js");

const registry = {
	regex: RegexMapper,
	static: StaticMapper,
	xpath: XPathMapper,
	jpath: JPathMapper,
	eval: EvalMapper,
	expression: ExpressionMapper,
};

/**
 * @param {string} type Mapper type as written in the configuration
 * @param {Object} parameters Mapper parameters
 * @param {{state?: Object}} [context] Shared accessory state (used by the eval mapper)
 * @returns {Object|undefined} The mapper, or undefined for an unknown type
 */
function createMapper(type, parameters, context) {
	if (!Object.prototype.hasOwnProperty.call(registry, type)) {
		return undefined;
	}
	return new registry[type](parameters, context);
}

module.exports = {
	StaticMapper,
	RegexMapper,
	XPathMapper,
	JPathMapper,
	EvalMapper,
	ExpressionMapper,
	createMapper,
	INCONCLUSIVE,
};
