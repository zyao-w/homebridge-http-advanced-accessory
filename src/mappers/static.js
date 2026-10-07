/** Dictionary mapper: returns the mapped value, or the input when there is no entry for it. */
class StaticMapper {
	constructor(parameters) {
		this.mapping = parameters.mapping;
	}

	map(value) {
		return Object.prototype.hasOwnProperty.call(this.mapping, value) ? this.mapping[value] : value;
	}
}

module.exports = StaticMapper;
