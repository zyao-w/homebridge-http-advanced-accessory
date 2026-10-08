const { INCONCLUSIVE } = require("./constants.js");

const asNumber = (value) => (typeof value === "string" && value.trim() !== "" ? Number(value) : value);
const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

/**
 * Converts a number from one range to another, for example 0-255 of a dimmer to 0-100 of HomeKit.
 * Input that is not a number is "inconclusive", so a fallback action can take over or the request fails.
 */
class ScaleMapper {
	constructor(parameters) {
		const range = {};
		for (const key of ["inputMin", "inputMax", "outputMin", "outputMax"]) {
			range[key] = asNumber(parameters[key]);
			if (!isNumber(range[key])) {
				throw new Error(`a "scale" mapper needs a number for "${key}"`);
			}
		}
		if (range.inputMin === range.inputMax) {
			throw new Error('a "scale" mapper needs an "inputMin" that differs from "inputMax"');
		}

		const round = asNumber(parameters.round);
		if (round !== undefined && round !== null && !(Number.isInteger(round) && round >= 0 && round <= 10)) {
			throw new Error('"round" of a "scale" mapper must be a whole number from 0 to 10');
		}

		Object.assign(this, range);
		this.round = round === null ? undefined : round;
		this.clamp = parameters.clamp === true;
	}

	map(value) {
		let input = asNumber(value);
		if (!isNumber(input)) {
			return INCONCLUSIVE;
		}

		if (this.clamp) {
			input = Math.min(Math.max(input, Math.min(this.inputMin, this.inputMax)), Math.max(this.inputMin, this.inputMax));
		}

		let output =
			this.outputMin + ((input - this.inputMin) * (this.outputMax - this.outputMin)) / (this.inputMax - this.inputMin);
		if (this.round !== undefined) {
			const factor = 10 ** this.round;
			output = Math.round(output * factor) / factor;
		}
		return output === 0 ? 0 : output;
	}
}

module.exports = ScaleMapper;
