// Not a class method: class bodies are strict, which would change how existing expressions run.
// The script sees `value`, `state` and `self` (e.g. `self.state`).
function evaluate(self, value, state) {
	return eval(self.exp);
}

/** Evaluates a JavaScript expression (trusted configuration only). */
class EvalMapper {
	constructor(parameters, context = {}) {
		this.exp = parameters.expression;
		this.state = context.state;
	}

	map(value) {
		return evaluate(this, value, this.state);
	}
}

module.exports = EvalMapper;
