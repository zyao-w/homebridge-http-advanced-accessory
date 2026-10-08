// Not a class method: class bodies are strict, which would change how existing expressions run.
// The script sees `value`, `state` and `self` (e.g. `self.state`).
function evaluate(self, value, state) {
	return eval(self.exp);
}

/** Runs JavaScript on the value (needs allowUnsafeEval; the configuration is trusted). */
class ScriptMapper {
	constructor(parameters, context = {}) {
		this.exp = parameters.script;
		this.state = context.state;
	}

	map(value) {
		return evaluate(this, value, this.state);
	}
}

module.exports = ScriptMapper;
