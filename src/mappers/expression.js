const { compileExpression } = require("../expression.js");

/** Evaluates an expression of the restricted expression language on the value. */
class ExpressionMapper {
	constructor(parameters, context = {}) {
		this.evaluate = compileExpression(String(parameters.expression === undefined ? "" : parameters.expression));
		this.state = context.state;
	}

	map(value) {
		return this.evaluate({ value, state: this.state });
	}
}

module.exports = ExpressionMapper;
