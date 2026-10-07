// Runs tasks with a concurrency cap and a minimum gap between task starts.
class Limiter {
	constructor({ maxConcurrent = 0, minGap = 0 } = {}) {
		this.max = maxConcurrent > 0 ? maxConcurrent : Infinity;
		this.gap = Math.max(0, minGap);
		this.active = 0;
		this.queue = [];
		this.nextStart = 0;
		this.timer = null;
	}

	run(task) {
		return new Promise((resolve, reject) => {
			this.queue.push({ task, resolve, reject });
			this._pump();
		});
	}

	_pump() {
		if (this.timer) return;

		while (this.queue.length && this.active < this.max) {
			const wait = this.nextStart - Date.now();
			if (wait > 0) {
				this.timer = setTimeout(() => {
					this.timer = null;
					this._pump();
				}, wait);
				return;
			}

			const job = this.queue.shift();
			this.active++;
			this.nextStart = Date.now() + this.gap;
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
