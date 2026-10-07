const { compileTemplate } = require("./expression.js");

/**
 * Renders a URL or body template: evaluates `${...}` expressions, then replaces `{value}`.
 *
 * Expressions see `value` (the raw HomeKit value) and `state` (the current characteristic values),
 * `{value}` is replaced with the value after the mapper chain (`mappedValue`).
 * `unsafe` evaluates `${...}` as full JavaScript instead of the restricted expression language.
 */
function renderTemplate(template, scope, options) {
	return compileTemplate(template, options)(scope);
}

module.exports = { renderTemplate };
