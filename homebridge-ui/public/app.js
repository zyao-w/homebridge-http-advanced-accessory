// The custom UI of the Homebridge settings page: a manager for the devices and a setup wizard for the first one.
// The form of the plugin that Homebridge generates stays available underneath: it is shown with showSchemaForm()
// and is never replaced, so everything can still be edited there.
(function () {
	"use strict";

	const Config = window.HttpAdvancedConfig;
	const Wizard = window.HttpAdvancedWizard;
	const I18n = window.HttpAdvancedI18n;
	const hb = window.homebridge;
	const root = document.getElementById("app");
	const REPOSITORY_URL = "https://github.com/zyao-w/homebridge-http-advanced-accessory";

	const state = {
		t: (key) => key,
		blocks: [],
		info: { testsDisabled: false },
		validation: { platform: [], devices: [] },
		cached: null,
		view: "home", // home, wizard, edit, import
		open: new Set(),
		results: {},
		exported: {},
		confirmDelete: -1,
		schemaVisible: true,
		wizard: null,
		importing: null,
		editing: null,
	};

	const clone = (value) => JSON.parse(JSON.stringify(value));
	const esc = (value) =>
		String(value === undefined || value === null ? "" : value)
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#39;");
	const t = (key, params) => state.t(key, params);

	function getPath(object, path) {
		return path.split(".").reduce((node, key) => (node === undefined || node === null ? undefined : node[key]), object);
	}

	function setPath(object, path, value) {
		const keys = path.split(".");
		const last = keys.pop();
		const target = keys.reduce((node, key) => node[key], object);
		target[last] = value;
	}

	/** Asks the server of the custom UI. A failure comes back as { ok: false, error } instead of an exception. */
	async function call(path, payload) {
		try {
			return await hb.request(path, payload);
		} catch (error) {
			const message = (error && (error.message || error.error)) || String(error);
			return { ok: false, error: message, failed: true };
		}
	}

	// ---- configuration ------------------------------------------------------------------------------------------

	const devices = () => Config.devicesOf(state.blocks);

	let validationTimer;
	function scheduleChecks() {
		clearTimeout(validationTimer);
		validationTimer = setTimeout(runChecks, 300);
	}

	async function runChecks() {
		const [validation, cached] = await Promise.all([call("/validate", { config: state.blocks }), loadCached()]);
		if (!validation.failed) state.validation = validation;
		state.cached = cached;
		// The other views show nothing of this, and drawing them again would take the focus from what is being typed
		if (state.view === "home") render();
	}

	async function loadCached() {
		try {
			const cached = await hb.getCachedAccessories();
			const result = await call("/cached", { config: state.blocks, cached });
			return result.failed ? null : result;
		} catch (error) {
			return null;
		}
	}

	// The form below the custom UI shows what getPluginConfig() gave, so it is rebuilt after a change made here
	function resyncSchemaForm() {
		if (state.schemaVisible && state.view === "home") {
			hb.hideSchemaForm();
			hb.showSchemaForm();
		}
	}

	async function commit(blocks) {
		state.blocks = blocks;
		await hb.updatePluginConfig(blocks);
		if (typeof hb.enableSaveButton === "function") hb.enableSaveButton();
		resyncSchemaForm();
		scheduleChecks();
		render();
	}

	// ---- rendering ----------------------------------------------------------------------------------------------

	function render() {
		const views = { home: renderHome, wizard: renderWizard, edit: renderEdit, import: renderImport };
		let html;
		try {
			html = (state.view === "home" ? "" : renderTopBar()) + views[state.view]();
		} catch (error) {
			// Whatever went wrong, the form of the plugin must remain usable
			console.error(error);
			html = notice("danger", esc(String((error && error.message) || error)));
			try {
				hb.showSchemaForm();
			} catch (ignored) {
				// nothing more to do
			}
		}
		root.innerHTML = html;
	}

	/** The way back and the title are at the top of every view but the list, so they are never far down the page. */
	function renderTopBar() {
		let back = { action: "wizard-cancel", label: t("backToDevices"), title: t("wizardTitle") };
		if (state.view === "wizard" && state.wizard.first) back.label = t("skipWizard");
		if (state.view === "import") back = { action: "import-cancel", label: t("backToDevices"), title: t("importTitle") };
		if (state.view === "edit") {
			const editing = state.editing;
			const device = editing.kind === "defaults" ? null : devices()[editing.index] || {};
			back = {
				action: "edit-cancel",
				label: t("backToDevices"),
				title: t("editing", { name: device ? device.name || t("unnamed") : t("defaults") }),
			};
		}
		return `<div class="d-flex flex-wrap align-items-center gap-3 mb-3 pb-2 border-bottom">
			${button(back.action, `← ${esc(back.label)}`, { small: true })}
			<h2 class="h5 mb-0">${esc(back.title)}</h2></div>`;
	}

	const button = (action, label, extra = {}) => {
		const attributes = Object.entries(extra.data || {})
			.map(([key, value]) => ` data-${key}="${esc(value)}"`)
			.join("");
		const title = extra.title ? ` title="${esc(extra.title)}" aria-label="${esc(extra.title)}"` : "";
		return `<button type="button" class="btn ${extra.cls || "btn-outline-secondary"} ${extra.small ? "btn-sm" : ""}" data-action="${action}"${attributes}${title}${extra.disabled ? " disabled" : ""}>${label}</button>`;
	};

	const notice = (kind, html) =>
		`<div class="alert alert-${kind}" role="${kind === "danger" ? "alert" : "status"}">${html}</div>`;
	const list = (items) => `<ul class="mb-0">${items.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>`;

	function renderHome() {
		const items = devices();
		const checks = state.validation.devices;
		// What is done often is at the top; what is needed rarely (the standard form, the import) is in the footer
		let html = `<div class="d-flex flex-wrap gap-2 mb-3">
			${button("wizard", esc(t("addWizard")), { cls: "btn-primary" })}
			${button("add-blank", esc(t("addBlank")))}
			${button("edit-defaults", esc(t("editDefaults")))}
		</div>`;

		if (state.info.testsDisabled) html += notice("warning", esc(t("testsDisabled")));
		if (state.validation.platform.length) {
			html += notice("danger", `<strong>${esc(t("platformProblems"))}</strong>${list(state.validation.platform)}`);
		}

		if (items.length === 0) {
			html += notice("info", `<strong>${esc(t("noDevices"))}</strong><br>${esc(t("noDevicesHelp"))}`);
		} else {
			html += `<h2 class="visually-hidden">${esc(t("devices"))}</h2><div class="device-grid">`;
			items.forEach((device, index) => {
				html += renderDeviceCard(device, index, checks[index]);
			});
			html += "</div>";
		}

		return html + renderCached() + renderFooter();
	}

	/** Quiet links for what is rarely needed, below everything else. Help is on the left, the actions on the right. */
	function renderFooter() {
		const link = (action, label) => button(action, esc(label), { small: true, cls: "btn-link text-muted px-0" });
		// The page is in a frame of the Homebridge UI, so the link opens a tab of its own and keeps no reference to it
		const help = `${esc(t("helpPrefix"))}<a href="${REPOSITORY_URL}" target="_blank" rel="noopener noreferrer">${esc(t("helpLink"))}</a>${esc(t("helpSuffix"))}`;
		return `<div class="d-flex flex-wrap justify-content-between align-items-center gap-3 mt-4 pt-2 border-top">
			<small class="text-muted">${help}</small>
			<div class="d-flex flex-wrap gap-3">
				${link("import", t("importLegacy"))}
				${link("toggle-schema", state.schemaVisible ? t("hideStandard") : t("showStandard"))}
			</div>
		</div>`;
	}

	function renderStatus(check) {
		if (!check) return `<span class="badge bg-secondary text-bg-secondary">${esc(t("checking"))}</span>`;
		if (check.errors.length) {
			return `<span class="badge bg-danger text-bg-danger">${esc(t("errorCount", { count: check.errors.length }))}</span>`;
		}
		if (check.warnings.length) {
			return `<span class="badge bg-warning text-dark text-bg-warning">${esc(t("warningCount", { count: check.warnings.length }))}</span>`;
		}
		return `<span class="badge bg-success text-bg-success">${esc(t("ok"))}</span>`;
	}

	/** One device as a card; it takes the whole width while its details or its export are open. */
	function renderDeviceCard(device, index, check) {
		const summary = Config.summarize(device);
		const open = state.open.has(index);
		const wide = open || Boolean(state.exported[index]);
		const data = { index };
		const confirming = state.confirmDelete === index;
		const faulty = Boolean(check && check.errors.length);
		const facts = [
			esc(summary.service || "—"),
			esc(t("characteristicCount", { count: summary.characteristics })),
			...(summary.additionalServices ? [esc(t("extraServices", { count: summary.additionalServices }))] : []),
		].join(" · ");

		return `<div class="${wide ? "wide" : ""}" data-device="${index}">
			<div class="card h-100${faulty ? " border-danger" : ""}">
				<div class="card-body">
					<div class="d-flex justify-content-between align-items-start gap-2">
						<div class="min-w-0">
							<h3 class="h6 card-title mb-1">${esc(summary.name || t("unnamed"))}</h3>
							<div class="text-muted small">${facts}</div>
							${summary.id ? `<div class="text-muted small">id: ${esc(summary.id)}</div>` : ""}
						</div>
						<div>${renderStatus(check)}</div>
					</div>
					${wide ? `<div class="mt-3">${renderDetails(device, index, check)}</div>` : ""}
				</div>
				<div class="card-footer bg-transparent d-flex flex-wrap justify-content-between gap-2">
					<div class="d-flex flex-wrap gap-1">
						${button("edit", esc(t("edit")), { small: true, cls: "btn-primary", data })}
						${button("toggle", esc(open ? t("hideDetails") : t("details")), { small: true, data })}
					</div>
					<div class="d-flex flex-wrap gap-1">
						${button("copy", esc(t("copy")), { small: true, data })}
						${button("up", "↑", { small: true, data, title: t("moveUp"), disabled: index === 0 })}
						${button("down", "↓", { small: true, data, title: t("moveDown"), disabled: index === devices().length - 1 })}
						${button("export", esc(t("export")), { small: true, data })}
						${
							confirming
								? button("delete-confirm", esc(t("confirmDelete")), { small: true, cls: "btn-danger", data }) +
									button("delete-cancel", esc(t("cancel")), { small: true, data })
								: button("delete", esc(t("delete")), { small: true, cls: "btn-outline-danger", data })
						}
					</div>
				</div>
			</div>
		</div>`;
	}

	function renderDetails(device, index, check) {
		let html = "";
		if (check && check.errors.length) html += notice("danger", list(check.errors));
		if (check && check.warnings.length) html += notice("warning", list(check.warnings));
		if (state.open.has(index) && !(typeof device.id === "string" && device.id)) {
			html += notice(
				"info",
				`${esc(t("noIdHint"))} ${button("pin-id", esc(t("pinId")), { small: true, data: { index } })}`
			);
		}

		if (state.exported[index]) {
			html += `<div class="mb-3"><label class="form-label" for="export-${index}">${esc(t("exportHelp"))}</label>
				<textarea id="export-${index}" class="form-control font-monospace" rows="10" readonly>${esc(state.exported[index])}</textarea>
				<div class="mt-1">${button("export-close", esc(t("close")), { small: true, data: { index } })}</div></div>`;
		}
		if (!state.open.has(index)) return html;

		const actions = Config.actionsOf(device);
		if (actions.length === 0) return html + `<p class="text-muted">${esc(t("noActions"))}</p>`;

		html += `<div class="table-responsive"><table class="table table-sm"><thead><tr><th scope="col">${esc(t("characteristic"))}</th><th scope="col">${esc(t("tests"))}</th></tr></thead><tbody>`;
		for (const action of actions) {
			const key = `${index}:${action.service}:${action.characteristic}`;
			const label = action.service ? `${action.service}: ${action.characteristic}` : action.characteristic;
			const data = { index, service: action.service, characteristic: action.characteristic };
			html += `<tr><td>${esc(label)}</td><td>`;
			if (action.get) {
				html += button("test-get", esc(t("testRead")), { small: true, data, disabled: state.info.testsDisabled });
				if (state.results[`${key}:get`]) html += `<div class="mt-2">${renderRead(state.results[`${key}:get`])}</div>`;
			}
			if (action.set) {
				html += `<div class="input-group input-group-sm mt-1" style="max-width: 24rem">
					<label class="input-group-text" for="value-${esc(key)}">${esc(t("previewValue"))}</label>
					<input id="value-${esc(key)}" class="form-control" data-preview-value="${esc(key)}" value="${esc(state.results[`${key}:value`] || "true")}">
					${button("preview-set", esc(t("previewSet")), { small: true, data })}</div>`;
				if (state.results[`${key}:set`])
					html += `<div class="mt-2">${renderPreview(state.results[`${key}:set`])}</div>`;
			}
			html += "</td></tr>";
		}
		return html + "</tbody></table></div>";
	}

	function renderSteps(steps) {
		if (!steps || steps.length === 0) return "";
		return `<div class="table-responsive"><table class="table table-sm table-bordered mb-2"><thead><tr><th scope="col">${esc(t("mapper"))}</th>
			<th scope="col">${esc(t("input"))}</th><th scope="col">${esc(t("output"))}</th></tr></thead><tbody>${steps
				.map(
					(step) =>
						`<tr><td>${esc(step.type)}</td><td><code>${esc(step.input)}</code></td><td>${
							step.error ? `<span class="text-danger">${esc(step.error)}</span>` : `<code>${esc(step.output)}</code>`
						}</td></tr>`
				)
				.join("")}</tbody></table></div>`;
	}

	function renderRead(result) {
		if (!result) return "";
		if (result.disabled) return notice("warning", esc(t("testsDisabled")));
		let html = "";
		if (!result.ok) {
			const status = result.status ? ` (HTTP ${esc(result.status)})` : "";
			html += notice("danger", `${esc(result.error || t("unknownError"))}${status}`);
		} else if (result.usedResultOnError) {
			html += notice(
				"warning",
				`${esc(t("usedResultOnError", { error: result.error }))} <code>${esc(result.value)}</code>`
			);
		} else {
			html += notice(
				"success",
				`${esc(t("homekitValue"))}: <code>${esc(result.value)}</code> <small>(HTTP ${esc(result.status)})</small>`
			);
		}
		html += renderSteps(result.steps);
		if (result.fallback) html += `<p class="mb-1"><em>${esc(t("fallbackRan"))}</em></p>${renderRead(result.fallback)}`;
		if (typeof result.body === "string") {
			html += `<details><summary>${esc(t("response"))}</summary><pre class="border rounded p-2 mt-1" style="max-height: 14rem; overflow: auto">${esc(result.body)}${result.truncated ? "\n…" : ""}</pre></details>`;
		}
		return html;
	}

	function renderPreview(result) {
		if (!result) return "";
		if (!result.ok) return notice("danger", esc(result.error || t("unknownError")));
		return notice(
			"info",
			`<strong>${esc(t("wouldSend"))}</strong><br>
			<code>${esc(result.method)} ${esc(result.url)}</code>
			${result.body ? `<pre class="mb-0 mt-1">${esc(result.body)}</pre>` : ""}
			<small>${esc(t("valueMapped", { value: result.value, mapped: result.mappedValue }))}</small>`
		);
	}

	function renderCached() {
		const cached = state.cached;
		if (!cached || (cached.accessories.length === 0 && cached.pending.length === 0)) return "";
		const orphans = cached.accessories.filter((accessory) => !accessory.configured);
		const repeated = cached.accessories.filter((accessory) => accessory.copies > 1);
		let html = `<details class="mt-3"><summary>${esc(t("cachedTitle", { count: cached.accessories.length }))}</summary><div class="mt-2">`;
		html += `<ul>${cached.accessories
			.map(
				(accessory) =>
					`<li>${esc(accessory.displayName)}${accessory.configured ? "" : ` <span class="badge bg-warning text-dark text-bg-warning">${esc(t("notConfigured"))}</span>`}${accessory.copies > 1 ? ` <span class="badge bg-secondary text-bg-secondary">${esc(t("cachedCopies", { count: accessory.copies }))}</span>` : ""}</li>`
			)
			.join("")}</ul>`;
		if (orphans.length) html += `<p class="text-muted">${esc(t("orphanHelp"))}</p>`;
		if (repeated.length) html += `<p class="text-muted">${esc(t("repeatedHelp"))}</p>`;
		if (cached.pending.length)
			html += `<p class="text-muted">${esc(t("pendingHelp", { names: cached.pending.join(", ") }))}</p>`;
		return html + "</div></details>";
	}

	// ---- import -------------------------------------------------------------------------------------------------

	function renderImport() {
		const imported = state.importing;
		let html = `<p>${esc(t("importHelp"))}</p>
			<label class="form-label" for="import-text">${esc(t("importLabel"))}</label>
			<textarea id="import-text" class="form-control font-monospace mb-2" rows="10">${esc(imported.text)}</textarea>
			<div class="d-flex gap-2 mb-3">${button("import-convert", esc(t("convert")), { cls: "btn-primary" })}${button("import-cancel", esc(t("cancel")))}</div>`;

		const result = imported.result;
		if (result && !result.ok) html += notice("danger", esc(result.error));
		if (result && result.ok) {
			html += notice("success", esc(t("importFound", { count: result.devices.length })));
			if (result.warnings.length)
				html += notice("warning", `<strong>${esc(t("importReview"))}</strong>${list(result.warnings)}`);
			html += button("import-add", esc(t("importAdd", { count: result.devices.length })), { cls: "btn-primary" });
		}
		return html;
	}

	// ---- editing with the form of a single device ---------------------------------------------------------------

	function renderEdit() {
		const editing = state.editing;
		const device = editing.kind === "defaults" ? null : devices()[editing.index] || {};
		let html = `<p class="text-muted">${esc(t("editingHelp"))}</p>`;
		if (device && !(typeof device.id === "string" && device.id)) html += notice("info", esc(t("noIdHint")));
		return html;
	}

	// What the form passes to onSubmit is the data of the form, possibly wrapped; take the data
	function formData(payload) {
		if (!payload || typeof payload !== "object") return null;
		for (const key of ["data", "value"]) {
			if (payload[key] && typeof payload[key] === "object" && !Array.isArray(payload[key])) return payload[key];
		}
		return payload;
	}

	function closeEditor() {
		state.view = "home";
		state.editing = null;
		if (state.schemaVisible) hb.showSchemaForm();
		render();
	}

	async function openEditor(kind, index) {
		const schema = await call(kind === "defaults" ? "/defaults-schema" : "/device-schema");
		if (schema.failed) {
			hb.toast.error(t("editorFailed"));
			return;
		}
		const initial = clone(kind === "defaults" ? Config.defaultsOf(state.blocks) : devices()[index]);

		let form;
		hb.hideSchemaForm();
		state.view = "edit";
		state.editing = { kind, index };
		render();
		try {
			form = hb.createForm(schema, initial, t("save"), t("cancel"));
		} catch (error) {
			hb.toast.error(t("editorFailed"));
			closeEditor();
			return;
		}
		state.editing.form = form;

		let latest = initial;
		form.onChange((change) => {
			const data = formData(change);
			if (data) latest = data;
		});
		form.onSubmit(async (payload) => {
			const data = formData(payload) || latest;
			form.end();
			const next =
				kind === "defaults" ? Config.setDefaults(state.blocks, data) : Config.replaceDevice(state.blocks, index, data);
			state.view = "home";
			state.editing = null;
			await commit(next);
			if (state.schemaVisible) hb.showSchemaForm();
		});
		form.onCancel(() => {
			form.end();
			closeEditor();
		});
	}

	// ---- wizard -------------------------------------------------------------------------------------------------

	const wizardSteps = () => Wizard.stepsFor(state.wizard.answers.kind);
	const currentStep = () => wizardSteps()[state.wizard.step];

	function startWizard(first) {
		state.wizard = {
			answers: Wizard.newAnswers(""),
			step: 0,
			first: Boolean(first),
			showProblems: false,
			raw: null,
			preview: null,
			setPreview: null,
			summary: null,
			busy: false,
		};
		state.view = "wizard";
		hb.hideSchemaForm();
		render();
	}

	function leaveWizard() {
		state.wizard = null;
		state.view = "home";
		if (state.schemaVisible) hb.showSchemaForm();
		render();
	}

	function field(label, path, options = {}) {
		const wizard = state.wizard;
		const value = getPath(wizard.answers, path);
		const invalid = wizard.showProblems && wizard.problems && wizard.problems.includes(path);
		const id = `w-${path.replace(/\./g, "-")}`;
		const rerender = options.rerender ? " data-rerender" : "";
		const common = `id="${id}" data-bind="${esc(path)}"${rerender}${invalid ? ' aria-invalid="true"' : ""}`;
		const hint = options.hint ? `<div class="form-text" id="${id}-hint">${esc(options.hint)}</div>` : "";
		const described = options.hint ? ` aria-describedby="${id}-hint"` : "";
		const error = invalid ? `<div class="text-danger small">${esc(t("fieldRequired"))}</div>` : "";
		const klass = `form-control${invalid ? " is-invalid" : ""}`;

		if (options.type === "checkbox") {
			return `<div class="form-check mb-3"><input type="checkbox" class="form-check-input" ${common}${value ? " checked" : ""}${described}>
				<label class="form-check-label" for="${id}">${esc(label)}</label>${hint}</div>`;
		}
		let control;
		if (options.type === "select") {
			control = `<select class="form-select${invalid ? " is-invalid" : ""}" ${common}${described}>${options.options
				.map(
					([optionValue, text]) =>
						`<option value="${esc(optionValue)}"${optionValue === value ? " selected" : ""}>${esc(text)}</option>`
				)
				.join("")}</select>`;
		} else if (options.type === "textarea") {
			control = `<textarea class="${klass} font-monospace" rows="3" ${common}${described}>${esc(value)}</textarea>`;
		} else {
			control = `<input type="${options.type || "text"}" class="${klass}" ${common} value="${esc(value)}" placeholder="${esc(options.placeholder || "")}"${described} autocomplete="off">`;
		}
		return `<div class="mb-3"><label class="form-label" for="${id}">${esc(label)}</label>${control}${hint}${error}</div>`;
	}

	const methodOptions = () => Wizard.HTTP_METHODS.map((method) => [method, method]);

	function pickFields(prefix) {
		const pick = getPath(state.wizard.answers, prefix);
		let html = field(t("pickType"), `${prefix}.type`, {
			type: "select",
			rerender: true,
			options: [
				["none", t("pickNone")],
				["jpath", t("pickJson")],
				["xpath", t("pickXml")],
				["regex", t("pickRegex")],
			],
		});
		if (pick.type === "regex") {
			html += field(t("regexp"), `${prefix}.regexp`, { placeholder: "temperature=(\\d+)" });
			html += field(t("capture"), `${prefix}.capture`, { placeholder: "1" });
		} else if (pick.type !== "none") {
			html += field(t("pickPath"), `${prefix}.path`, {
				placeholder: pick.type === "jpath" ? "$.data.value" : "//value/text()",
			});
		}
		return html;
	}

	function renderSuggestions(target) {
		const raw = state.wizard.raw;
		if (!raw || !raw.suggestions || raw.suggestions.length === 0) return "";
		return `<p class="mb-1">${esc(t("suggestions"))}</p><div class="list-group mb-3" style="max-height: 14rem; overflow: auto">${raw.suggestions
			.map(
				(suggestion, index) =>
					`<button type="button" class="list-group-item list-group-item-action" data-action="wizard-suggest" data-target="${target}" data-i="${index}">
						<code>${esc(suggestion.path)}</code> <span class="text-muted">→ ${esc(suggestion.sample)}</span></button>`
			)
			.join("")}</div>`;
	}

	function renderWizardStep(step) {
		const wizard = state.wizard;
		const answers = wizard.answers;
		const info = Wizard.KINDS[answers.kind];
		let html = "";

		if (step === "kind") {
			html += `<p>${esc(t("wizardKindHelp"))}</p><div class="choice-grid">`;
			for (const [kind, kindInfo] of Object.entries(Wizard.KINDS)) {
				html += `<button type="button" class="btn ${answers.kind === kind ? "btn-primary" : "btn-outline-primary"} w-100 text-start" data-action="wizard-kind" data-kind="${kind}">
					<strong>${esc(t(`kind.${kind}`))}</strong><br><small>${esc(kindInfo.service)}</small></button>`;
			}
			html += `<button type="button" class="btn btn-outline-secondary w-100 text-start" data-action="wizard-other">
				<strong>${esc(t("kind.other"))}</strong><br><small>${esc(t("kind.otherHelp"))}</small></button></div>`;
			return html;
		}

		if (step === "connection") {
			html += field(t("deviceName"), "name", { hint: t("deviceNameHelp") });
			html += field(t("url"), "url", { placeholder: "http://192.168.1.10/api/status" });
			html += field(t("httpMethod"), "httpMethod", { type: "select", options: methodOptions(), rerender: true });
			if (answers.httpMethod !== "GET") html += field(t("body"), "body", { type: "textarea" });
			html += field(t("authType"), "authType", {
				type: "select",
				rerender: true,
				options: [
					["none", t("authNone")],
					["bearer", t("authBearer")],
					["basic", t("authBasic")],
				],
			});
			if (answers.authType === "bearer")
				html += field(t("bearerToken"), "bearerToken", { type: "password", hint: t("tokenHelp") });
			if (answers.authType === "basic") {
				html += field(t("username"), "username");
				html += field(t("password"), "password", { type: "password" });
			}
			return html;
		}

		if (step === "pick") {
			html += `<p>${esc(t("pickHelp"))}</p>`;
			html += button("wizard-send", esc(wizard.busy ? t("sending") : t("sendRequest")), {
				cls: "btn-primary",
				disabled: state.info.testsDisabled || wizard.busy,
			});
			html += state.info.testsDisabled ? `<div class="mt-2">${notice("warning", esc(t("testsDisabled")))}</div>` : "";
			if (wizard.raw) {
				html += `<div class="mt-3">${wizard.raw.ok ? notice("success", esc(t("responseOk", { status: wizard.raw.status, format: t(`format.${wizard.raw.format}`) }))) : renderRead(wizard.raw)}</div>`;
				if (wizard.raw.ok) {
					html += `<details class="mb-3"><summary>${esc(t("response"))}</summary><pre class="border rounded p-2 mt-1" style="max-height: 14rem; overflow: auto">${esc(wizard.raw.body)}${wizard.raw.truncated ? "\n…" : ""}</pre></details>`;
					html += renderSuggestions("pick");
				}
			}
			html += pickFields("pick");
			html += renderPreviewBlock();
			return html;
		}

		if (step === "interpret") {
			if (info.value === "number") {
				html += `<p>${esc(t("interpretNumber"))}</p>`;
				html += field(t("decimals"), "round", { type: "number", hint: t("decimalsHelp"), placeholder: "1" });
			} else if (info.value === "binary") {
				html += `<p>${esc(t("interpretBinary"))}</p>`;
				html += field(t("triggeredText"), "triggeredText", { hint: t("triggeredHelp") });
				html += field(t("normalText"), "normalText");
			} else {
				html += `<p>${esc(t("interpretState"))}</p>`;
				html += field(t("onText"), "onText", { hint: t("onHelp") });
				html += field(t("offText"), "offText");
			}
			if (info.brightness) {
				html += `<hr>` + field(t("brightnessEnable"), "brightness.enabled", { type: "checkbox", rerender: true });
				if (answers.brightness.enabled) {
					html += renderSuggestions("brightness.pick");
					html += pickFields("brightness.pick");
					html += field(t("deviceMax"), "brightness.deviceMax", { type: "number", hint: t("deviceMaxHelp") });
				}
			}
			html += renderPreviewBlock();
			return html;
		}

		if (step === "set") {
			html += `<p>${esc(t("setHelp"))}</p>`;
			html += field(t("setEnable"), "set.enabled", { type: "checkbox", rerender: true });
			if (answers.set.enabled) {
				html += field(t("setUrl"), "set.url", {
					hint: t("setUrlHelp"),
					placeholder: "http://192.168.1.10/api/power?on={value}",
				});
				html += field(t("httpMethod"), "set.httpMethod", { type: "select", options: methodOptions(), rerender: true });
				if (answers.set.httpMethod !== "GET")
					html += field(t("body"), "set.body", { type: "textarea", hint: t("setBodyHelp") });
				html += field(t("onValue"), "set.onValue", { hint: t("onValueHelp") });
				html += field(t("offValue"), "set.offValue");
			}
			if (info.brightness && answers.brightness.enabled) {
				html += `<hr>` + field(t("brightnessSetEnable"), "brightness.setEnabled", { type: "checkbox", rerender: true });
				if (answers.brightness.setEnabled) {
					html += field(t("setUrl"), "brightness.setUrl", {
						hint: t("setUrlHelp"),
						placeholder: "http://192.168.1.10/api/level?v={value}",
					});
					html += field(t("httpMethod"), "brightness.setHttpMethod", {
						type: "select",
						options: methodOptions(),
						rerender: true,
					});
					if (answers.brightness.setHttpMethod !== "GET")
						html += field(t("body"), "brightness.setBody", { type: "textarea" });
				}
			}
			if (answers.set.enabled || answers.brightness.setEnabled) {
				html += button("wizard-preview-set", esc(t("previewSet")), { cls: "btn-outline-primary" });
				if (wizard.setPreview) html += `<div class="mt-2">${renderPreview(wizard.setPreview)}</div>`;
			}
			return html;
		}

		if (step === "options") {
			html += field(t("pollInterval"), "pollInterval", { type: "number", hint: t("pollHelp") });
			html += field(t("statusFault"), "statusFault", { type: "checkbox", hint: t("statusFaultHelp") });
			html += field(t("deviceId"), "id", { hint: t("deviceIdHelp") });
			return html;
		}

		// summary
		const summary = wizard.summary;
		html += `<p>${esc(t("summaryHelp"))}</p>`;
		if (summary && summary.check && summary.check.errors.length) html += notice("danger", list(summary.check.errors));
		if (summary && summary.check && summary.check.warnings.length)
			html += notice("warning", list(summary.check.warnings));
		if (summary && summary.check && !summary.check.errors.length) html += notice("success", esc(t("summaryOk")));
		html += `<pre class="border rounded p-2" style="max-height: 20rem; overflow: auto">${esc(summary ? summary.json : "")}</pre>`;
		html += `<p class="text-muted">${esc(t("summarySave"))}</p>`;
		return html;
	}

	function renderPreviewBlock() {
		const preview = state.wizard.preview;
		let html = `<div class="mt-3">${button("wizard-preview", esc(t("previewResult")), { disabled: state.info.testsDisabled })}</div>`;
		if (preview) html += `<div class="mt-2">${renderRead(preview)}</div>`;
		return html;
	}

	function renderWizard() {
		const wizard = state.wizard;
		const steps = wizardSteps();
		const step = steps[wizard.step];
		wizard.problems = Wizard.problems(wizard.answers, step);

		const progress =
			steps.length > 1 ? t("stepOf", { step: wizard.step + 1, count: steps.length }) : t("step", { step: 1 });
		const percent = steps.length > 1 ? Math.round(((wizard.step + 1) / steps.length) * 100) : 0;
		let html = `<div class="progress mb-2" style="height: 0.4rem" role="progressbar" aria-label="${esc(progress)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}">
				<div class="progress-bar" style="width: ${percent}%"></div></div>
			<p class="text-muted mb-3">${esc(progress)} — <strong>${esc(t(`step.${step}`))}</strong></p>`;
		if (wizard.first) html += `<p>${esc(t("wizardWelcome"))}</p>`;
		html += `<div class="mb-3">${renderWizardStep(step)}</div><div class="d-flex flex-wrap gap-2">`;
		if (wizard.step > 0) html += button("wizard-back", esc(t("back")));
		if (step === "summary") {
			html += button("wizard-add", esc(t("addDevice")), {
				cls: "btn-primary",
				disabled: Boolean(wizard.summary && wizard.summary.check && wizard.summary.check.errors.length),
			});
			html += button("wizard-add-edit", esc(t("addAndEdit")), { cls: "btn-outline-primary" });
		} else if (step !== "kind") {
			html += button("wizard-next", esc(t("next")), { cls: "btn-primary" });
		}
		return html + "</div>";
	}

	function applySuggestion(target, index) {
		const wizard = state.wizard;
		const suggestion = wizard.raw && wizard.raw.suggestions[index];
		if (!suggestion) return;
		const pick = getPath(wizard.answers, target);
		pick.type = suggestion.type;
		pick.path = suggestion.path;
	}

	async function wizardSend() {
		const wizard = state.wizard;
		if (Wizard.problems(wizard.answers, "connection").length) {
			wizard.showProblems = true;
			wizard.step = wizardSteps().indexOf("connection");
			render();
			return;
		}
		wizard.busy = true;
		render();
		const info = Wizard.KINDS[wizard.answers.kind];
		wizard.raw = await call("/test-get", {
			device: Wizard.probeDevice(wizard.answers),
			characteristic: info.characteristic,
			uiAuth: hb.serverEnv && hb.serverEnv.formAuth,
		});
		wizard.busy = false;
		render();
	}

	function buildable() {
		return ["connection", "pick", "interpret"].every(
			(step) => Wizard.problems(state.wizard.answers, step).length === 0
		);
	}

	async function wizardPreview() {
		const wizard = state.wizard;
		if (!buildable()) {
			wizard.showProblems = true;
			render();
			return;
		}
		const device = Wizard.buildDevice(wizard.answers);
		wizard.preview = await call("/test-get", {
			device,
			characteristic: Wizard.KINDS[wizard.answers.kind].characteristic,
			uiAuth: hb.serverEnv && hb.serverEnv.formAuth,
		});
		render();
	}

	async function wizardPreviewSet() {
		const wizard = state.wizard;
		if (!buildable() || Wizard.problems(wizard.answers, "set").length) {
			wizard.showProblems = true;
			render();
			return;
		}
		const device = Wizard.buildDevice(wizard.answers);
		const main = wizard.answers.set.enabled;
		wizard.setPreview = await call("/preview-set", {
			device,
			characteristic: main ? Wizard.KINDS[wizard.answers.kind].characteristic : "Brightness",
			value: main ? "true" : "50",
		});
		render();
	}

	async function wizardNext() {
		const wizard = state.wizard;
		const step = currentStep();
		if (Wizard.problems(wizard.answers, step).length) {
			wizard.showProblems = true;
			render();
			return;
		}
		wizard.showProblems = false;
		wizard.step += 1;
		if (currentStep() === "summary") await prepareSummary();
		render();
	}

	async function prepareSummary() {
		const wizard = state.wizard;
		const device = Wizard.buildDevice(wizard.answers);
		const blocks = Config.addDevice(state.blocks, device);
		const check = await call("/validate", { config: blocks });
		const index = Config.devicesOf(blocks).length - 1;
		wizard.summary = { json: Config.exportDevice(device), device, check: check.failed ? null : check.devices[index] };
	}

	async function wizardAdd(edit) {
		const wizard = state.wizard;
		const blocks = Config.addDevice(state.blocks, wizard.summary.device);
		const index = Config.devicesOf(blocks).length - 1;
		// The first device ends the first run: from now on the standard form is shown only on request
		if (devices().length === 0) state.schemaVisible = false;
		state.wizard = null;
		state.view = "home";
		await commit(blocks);
		hb.toast.success(t("deviceAdded"));
		if (edit) await openEditor("device", index);
		else if (state.schemaVisible) hb.showSchemaForm();
	}

	// ---- events -------------------------------------------------------------------------------------------------

	const actions = {
		wizard: () => startWizard(false),
		"add-blank": async () => {
			const name = Config.freeName(
				Wizard.blankDevice(t("newDevice")).name,
				devices().map((device) => device.name)
			);
			const blocks = Config.addDevice(state.blocks, Wizard.blankDevice(name));
			await commit(blocks);
			await openEditor("device", Config.devicesOf(blocks).length - 1);
		},
		"edit-defaults": () => openEditor("defaults"),
		import: () => {
			state.importing = { text: "", result: null };
			state.view = "import";
			hb.hideSchemaForm();
			render();
		},
		"toggle-schema": () => {
			state.schemaVisible = !state.schemaVisible;
			if (state.schemaVisible) hb.showSchemaForm();
			else hb.hideSchemaForm();
			render();
		},
		toggle: ({ index }) => {
			if (state.open.has(index)) state.open.delete(index);
			else state.open.add(index);
			render();
		},
		edit: ({ index }) => openEditor("device", index),
		copy: ({ index }) => commit(Config.duplicateDevice(state.blocks, index)),
		"pin-id": ({ index }) => commit(Config.pinId(state.blocks, index)),
		up: ({ index }) => commit(Config.moveDevice(state.blocks, index, -1)),
		down: ({ index }) => commit(Config.moveDevice(state.blocks, index, 1)),
		export: ({ index }) => {
			state.exported[index] = Config.exportDevice(devices()[index]);
			render();
		},
		"export-close": ({ index }) => {
			delete state.exported[index];
			render();
		},
		delete: ({ index }) => {
			state.confirmDelete = index;
			render();
		},
		"delete-cancel": () => {
			state.confirmDelete = -1;
			render();
		},
		"delete-confirm": async ({ index }) => {
			state.confirmDelete = -1;
			state.open.clear();
			state.exported = {};
			state.results = {};
			await commit(Config.removeDevice(state.blocks, index));
		},
		"test-get": async ({ index, service, characteristic }) => {
			const key = `${index}:${service}:${characteristic}:get`;
			state.results[key] = { ok: true, value: t("sending"), status: "…", steps: [] };
			render();
			state.results[key] = await call("/test-get", {
				device: devices()[index],
				defaults: Config.defaultsOf(state.blocks),
				service,
				characteristic,
				uiAuth: hb.serverEnv && hb.serverEnv.formAuth,
			});
			render();
		},
		"preview-set": async ({ index, service, characteristic }) => {
			const key = `${index}:${service}:${characteristic}`;
			const input = root.querySelector(`[data-preview-value="${key}"]`);
			const value = input ? input.value : "true";
			state.results[`${key}:value`] = value;
			state.results[`${key}:set`] = await call("/preview-set", {
				device: devices()[index],
				defaults: Config.defaultsOf(state.blocks),
				service,
				characteristic,
				value,
			});
			render();
		},
		"edit-cancel": () => {
			const form = state.editing && state.editing.form;
			if (form) form.end();
			closeEditor();
		},
		"import-cancel": () => {
			state.importing = null;
			state.view = "home";
			if (state.schemaVisible) hb.showSchemaForm();
			render();
		},
		"import-convert": async () => {
			const input = root.querySelector("#import-text");
			state.importing.text = input ? input.value : state.importing.text;
			state.importing.result = await call("/import-1x", { config: state.importing.text });
			render();
		},
		"import-add": async () => {
			const result = state.importing.result;
			state.importing = null;
			state.view = "home";
			await commit(Config.addDevices(state.blocks, result.devices));
			hb.toast.success(t("importAdded", { count: result.devices.length }));
			if (state.schemaVisible) hb.showSchemaForm();
		},
		"wizard-kind": ({ kind }) => {
			const wizard = state.wizard;
			wizard.answers.kind = kind;
			if (!wizard.answers.name) wizard.answers.name = t(`kind.${kind}`);
			wizard.raw = wizard.preview = null;
			wizard.step = 1;
			render();
		},
		"wizard-other": async () => {
			state.wizard = null;
			state.view = "home";
			await actions["add-blank"]();
		},
		"wizard-back": () => {
			state.wizard.step = Math.max(0, state.wizard.step - 1);
			state.wizard.showProblems = false;
			render();
		},
		"wizard-next": wizardNext,
		"wizard-cancel": leaveWizard,
		"wizard-send": wizardSend,
		"wizard-preview": wizardPreview,
		"wizard-preview-set": wizardPreviewSet,
		"wizard-suggest": async ({ target, i }) => {
			applySuggestion(target, Number(i));
			render();
			if (target === "pick" && buildable()) await wizardPreview();
		},
		"wizard-add": () => wizardAdd(false),
		"wizard-add-edit": () => wizardAdd(true),
	};

	root.addEventListener("click", (event) => {
		const target = event.target.closest("[data-action]");
		if (!target || target.disabled) return;
		const handler = actions[target.dataset.action];
		if (!handler) return;
		const data = { ...target.dataset };
		if (data.index !== undefined) data.index = Number(data.index);
		Promise.resolve(handler(data)).catch((error) => hb.toast.error(String((error && error.message) || error)));
	});

	function bind(event) {
		if (event.target.id === "import-text" && state.importing) {
			state.importing.text = event.target.value;
			return;
		}
		const target = event.target.closest("[data-bind]");
		if (!target || !state.wizard) return;
		const value = target.type === "checkbox" ? target.checked : target.value;
		setPath(state.wizard.answers, target.dataset.bind, value);
		if (event.type === "change" && target.hasAttribute("data-rerender")) {
			state.wizard.preview = null;
			render();
			const again = root.querySelector(`[data-bind="${target.dataset.bind}"]`);
			if (again) again.focus();
		}
	}
	root.addEventListener("input", bind);
	root.addEventListener("change", bind);

	// ---- start --------------------------------------------------------------------------------------------------

	async function init() {
		const lang = await hb.i18nCurrentLang().catch(() => "en");
		state.t = I18n.createTranslator(lang);
		document.documentElement.lang = I18n.normalizeLanguage(lang);

		state.blocks = await hb.getPluginConfig();
		const info = await call("/info");
		if (!info.failed) state.info = info;

		// The form of the plugin stays under this page. A change made in it shows here too. What the event carries is
		// used only when it is the configuration of this plugin; anything else (an empty form, for example) is
		// ignored, and the Homebridge UI is asked instead, so that the list never turns empty by mistake.
		window.homebridge.addEventListener("configChanged", async (event) => {
			if (state.view !== "home") return;
			let blocks = Config.blocksFrom(event.data);
			if (!blocks) {
				try {
					blocks = Config.blocksFrom(await hb.getPluginConfig());
				} catch (ignored) {
					// keep what is shown
				}
			}
			if (!blocks || state.view !== "home") return;
			state.blocks = blocks;
			scheduleChecks();
		});

		if (devices().length === 0) {
			startWizard(true);
		} else {
			// With devices, this page has what is needed and the standard form is one button away; with none, the
			// standard form is the alternative to the wizard and is shown when the wizard is skipped
			state.schemaVisible = false;
			render();
		}
		scheduleChecks();
	}

	init().catch((error) => {
		root.innerHTML = notice("danger", esc(String((error && error.message) || error)));
		// Whatever went wrong here, the form of the plugin must remain usable
		try {
			hb.showSchemaForm();
		} catch (ignored) {
			// nothing more to do
		}
	});
})();
