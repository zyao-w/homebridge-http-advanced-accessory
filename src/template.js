/**
 * Renders a URL or body template: evaluates `${...}` expressions, then replaces `{value}`.
 *
 * Expressions see `value` (the raw HomeKit value) and `state` (the current characteristic values),
 * `{value}` is replaced with the value after the mapper chain (`mappedValue`).
 * Templates come from the trusted configuration file.
 */
function renderTemplate(template, { value, state, mappedValue }) {
	return eval("`" + template + "`").replace(/{value}/gi, mappedValue);
}

module.exports = { renderTemplate };
