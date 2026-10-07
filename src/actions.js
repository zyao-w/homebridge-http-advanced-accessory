const { createMapper } = require("./mappers/index.js");

/**
 * Builds an action from its configuration:
 * { url, httpMethod, body, resultOnError, mappers: [], inconclusive: <action> }
 *
 * @param {Object} description The action as written in the configuration
 * @param {{state?: Object, warn?: Function}} [context]
 */
function createAction(description, context = {}) {
	const action = {
		url: description.url,
		httpMethod: description.httpMethod || "GET",
		body: description.body || "",
		resultOnError: description.resultOnError,
	};

	if (description.mappers) {
		action.mappers = [];
		for (const definition of description.mappers) {
			const mapper = createMapper(definition.type, definition.parameters, context);
			if (mapper) {
				action.mappers.push(mapper);
			} else if (context.warn) {
				context.warn('Unknown mapper type "' + definition.type + '" ignored');
			}
		}
	}

	if (description.inconclusive) {
		action.inconclusive = createAction(description.inconclusive, context);
	}

	return action;
}

/** Builds every action of a `urls` section, keyed by action name (e.g. getOn, setOn). */
function createActions(urls, context) {
	const actions = {};
	for (const name of Object.keys(urls || {})) {
		actions[name] = createAction(urls[name], context);
	}
	return actions;
}

module.exports = { createAction, createActions };
