// Runs tasks with a concurrency cap.
class Limiter {
	constructor({ maxConcurrent = 0 } = {}) {
		this.max = maxConcurrent > 0 ? maxConcurrent : Infinity;
		this.active = 0;
		this.queue = [];
	}

	run(task) {
		return new Promise((resolve, reject) => {
			this.queue.push({ task, resolve, reject });
			this._pump();
		});
	}

	_pump() {
		while (this.queue.length && this.active < this.max) {
			const job = this.queue.shift();
			this.active++;
			Promise.resolve()
				.then(job.task)
				.then(job.resolve, job.reject)
				.finally(() => {
					this.active--;
					this._pump();
				});
		}
	}
}

module.exports = Limiter;
