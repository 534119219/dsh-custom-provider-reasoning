/**
 * dsh-custom-provider-reasoning — host half
 *
 * Makes every custom (hand-declared) pi-ai provider route expose selectable
 * reasoning-effort levels in the composer model picker, without touching the
 * stock adapter pipeline.
 *
 * Why this exists
 * ---------------
 * The model selector only shows an Effort row when the adapter publishes
 * `reasoning` metadata for the exact model (`resolveModelInfo` →
 * `model.reasoning.efforts`), and dsh-llm-pi-ai materializes that metadata
 * exclusively from the model entry's `reasoningEfforts` declaration in the
 * `llm-pi-ai` settings section. The settings UI deliberately writes no such
 * field (effort is a per-MODEL capability), so every model on a route pi-ai
 * does not ship resolves as non-reasoning and the picker offers nothing.
 *
 * This plugin closes the gap at the supported configuration seam: whenever
 * the llm-pi-ai section changes (or the adapter directory publishes), it
 * writes a `reasoningEfforts` dict into every qualifying model entry that
 * lacks one. Everything downstream — the `session.models` / `llm.models`
 * RPCs, request-time validation in `resolveCallConfig`, and the wire
 * translation (pi-ai sends `reasoning_effort` for OpenAI-compatible
 * endpoints) — then runs through the stock adapter unchanged.
 *
 * Qualifying model entries
 * ------------------------
 * - `scope: declared` (default): every model on a route pi-ai does not ship
 *   (`declared` in the llm directory) — exactly what the GUI's
 *   "Add a custom provider" card creates.
 * - `scope: all`: additionally, models a catalog route lists that the
 *   installed pi-ai catalog does not describe (user-added ids pi-ai has not
 *   caught up with). Catalog-described models are always left to the
 *   catalog's own reasoning metadata.
 *
 * An entry that already carries `reasoningEfforts` — a hand-tuned dict or an
 * explicit `false` ("this model is not a reasoning model") — is never
 * touched, with one exception: a dict that is byte-for-byte the built-in
 * default can only have been written by this plugin itself, so it is
 * refreshed whenever the configured `levels` change. Raising `levels` in
 * the patch config therefore reaches every provider the plugin already
 * covered, while genuine user configuration stays authoritative.
 * Injections are additive and idempotent: once a model is covered, no
 * further writes happen, so the plugin never fights the settings UI or
 * loops.
 *
 * Write shape: `settings.mutate` path ops address object keys only (an array
 * child is not walkable), so each route's `models` array is rewritten as one
 * whole-array op — the same shape the settings UI itself persists — with
 * every other field and the array order preserved.
 *
 * No third-party runtime dependencies beyond the harness's own packages:
 * the plugin talks to the `settings` and `llm` services and reads the
 * pi-ai model catalog only for the optional `all` scope.
 */
import z from "@deepseek-ai/schemastery";

// ---------------------------------------------------------------- identity

const name = "dsh-custom-provider-reasoning";
const inject = ["llm", "settings"];

// ---------------------------------------------------------------- constants

/** The settings namespace owned by @deepseek-ai/dsh-llm-pi-ai. */
const NS = "llm-pi-ai";
/** Every pi-ai thinking level a profile may declare, in escalation order. */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/**
 * Default selectable levels: the OpenAI-compatible `reasoning_effort`
 * vocabulary. `off` is valueless (supported, send nothing — the endpoint
 * keeps its own default), the rest map 1:1 to their wire spelling.
 * Not frozen: schemastery resolves `.default()` values in place.
 */
const DEFAULT_LEVELS = { off: null, low: "low", medium: "medium", high: "high" };

/** Plugin configuration, resolved by the harness settings/loader layers. */
const Config = z.object({
	enabled: z.boolean().default(true),
	scope: z.union([z.const("declared"), z.const("all")]).default("declared"),
	levels: z.dict(z.union([z.string(), z.const(null)]), z.union(THINKING_LEVELS)).default(DEFAULT_LEVELS),
	/** After a publish, resolve each injected model and log its reasoning metadata (diagnostics). */
	verify: z.boolean().default(false)
});

// ---------------------------------------------------------------- helpers

/**
 * Validate a configured levels dict the way pi-ai's own resolution will read
 * it. A bad dict would make the whole route unserviceable at profile
 * resolution (dsh-llm-pi-ai rejects an empty dict, unknown levels, empty
 * wire spellings, and a dict with no level beyond `off`), so the plugin
 * refuses to run rather than brick a route.
 * @param levels - the configured dict.
 * @returns an error message, or null when the dict is safe to inject.
 */
function validateLevels(levels) {
	if (typeof levels !== "object" || levels === null || Array.isArray(levels)) return "levels must be an object";
	const entries = Object.entries(levels);
	if (entries.length === 0) return "levels declares no levels";
	for (const [level, wire] of entries) {
		if (!THINKING_LEVELS.includes(level)) return `levels names unknown level "${level}"`;
		if (wire !== null && (typeof wire !== "string" || wire.length === 0)) return `level "${level}" needs a wire value or null`;
	}
	if (!entries.some(([level, wire]) => level !== "off" && typeof wire === "string" && wire.length > 0)) {
		return "levels offers no thinking level beyond off";
	}
	return null;
}

/**
 * Plain-object deep equality over JSON-shaped data (strings, numbers, null,
 * arrays, plain objects). Key order does not matter.
 * @param left - one value.
 * @param right - the other value.
 * @returns whether the two values are structurally equal.
 */
function deepEqualPlain(left, right) {
	if (left === right) return true;
	if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
	if (Array.isArray(left) !== Array.isArray(right)) return false;
	if (Array.isArray(left)) {
		if (left.length !== right.length) return false;
		return left.every((value, index) => deepEqualPlain(value, right[index]));
	}
	const leftKeys = Object.keys(left);
	const rightKeys = Object.keys(right);
	if (leftKeys.length !== rightKeys.length) return false;
	return leftKeys.every((key) => key in right && deepEqualPlain(left[key], right[key]));
}

/**
 * Compute the settings ops that give every qualifying model entry a
 * `reasoningEfforts` declaration, without touching anything else in the
 * section. One whole-`models`-array op per affected route (the settings
 * mutate seam cannot walk array elements, and this is the same shape the
 * settings UI itself persists).
 * @param user - the raw user section of the llm-pi-ai namespace.
 * @param declaredRoutes - provider ids pi-ai does not ship.
 * @param catalogModelIds - map of route → catalog model id set, or null when
 *   catalog routes are out of scope.
 * @param levels - validated levels dict to inject.
 * @returns `{ ops, injected }` — ordered mutate ops and the route/model ids
 *   they cover; ops is empty when nothing to do.
 */
function planOps(user, declaredRoutes, catalogModelIds, levels) {
	const ops = [];
	const injected = [];
	const providers = user?.providers;
	if (typeof providers !== "object" || providers === null || Array.isArray(providers)) return { ops, injected };
	for (const [route, profile] of Object.entries(providers)) {
		if (typeof profile !== "object" || profile === null || Array.isArray(profile)) continue;
		const declared = declaredRoutes.has(route);
		if (!declared && catalogModelIds === null) continue;
		const models = profile.models;
		if (!Array.isArray(models)) continue;
		let next = null; // lazily cloned array, only when at least one entry qualifies
		for (let index = 0; index < models.length; index++) {
			const entry = models[index];
			if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
			// A hand-tuned dict or an explicit `false` wins — with one
			// exception: a dict this plugin itself wrote from the built-in
			// default is plugin-owned, so it is refreshed when the configured
			// `levels` change. That is what makes raising `levels` in the
			// patch config reach every provider the plugin already covered.
			const existing = entry.reasoningEfforts;
			if (existing !== void 0 && !(deepEqualPlain(existing, DEFAULT_LEVELS) && !deepEqualPlain(levels, DEFAULT_LEVELS))) {
				continue;
			}
			if (!declared) {
				// `all` scope on a catalog route: only cover ids the installed
				// catalog does not describe; catalog-described models keep the
				// catalog's own reasoning metadata.
				const known = catalogModelIds?.get(route);
				if (known?.has(entry.id)) continue;
			}
			next ??= models.map((model) =>
				typeof model === "object" && model !== null && !Array.isArray(model) ? { ...model } : model
			);
			next[index] = { ...next[index], reasoningEfforts: { ...levels } };
			injected.push({ route, model: entry.id });
		}
		if (next !== null) ops.push({ op: "set", path: ["providers", route, "models"], value: next });
	}
	return { ops, injected };
}

// ---------------------------------------------------------------- apply

/**
 * Keep every qualifying custom-provider model entry furnished with a
 * `reasoningEfforts` declaration, re-running on every relevant change.
 * Writes are serialized per namespace by the settings service; the plugin
 * serializes its own refresh rounds as well, and every round is idempotent.
 */
function apply(ctx, config = {}) {
	const { enabled = true, scope = "declared", levels = DEFAULT_LEVELS, verify = false } = config;
	if (!enabled) return;
	const levelError = validateLevels(levels);
	if (levelError !== null) {
		ctx.logger.error(`[${name}] refusing to run: ${levelError}`);
		return;
	}

	/** Serialize refresh rounds so two triggers never interleave writes. */
	let tail = Promise.resolve();
	const queue = (task) => {
		tail = tail.then(task).catch((error) => {
			ctx.logger.error(`[${name}] refresh failed`);
			ctx.logger.error(error);
		});
	};

	const refresh = () => queue(async () => {
		const settings = ctx.settings;
		if (settings === void 0) return;
		let descriptor;
		try {
			descriptor = settings.describe().find((entry) => entry.ns === NS);
		} catch (error) {
			ctx.logger.warn(`[${name}] cannot read settings: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		if (descriptor === void 0) return; // llm-pi-ai not registered yet; a later event retries
		const user = descriptor.user === void 0 ? {} : structuredClone(descriptor.user);

		const directory = ctx.llm.listConfigurableProviders();
		const declaredRoutes = new Set(
			directory.filter((entry) => entry.settingsNs === NS && entry.declared === true).map((entry) => entry.provider)
		);
		let catalogModelIds = null;
		if (scope === "all") {
			catalogModelIds = new Map();
			for (const entry of directory) {
				if (entry.settingsNs !== NS || entry.declared === true) continue;
				try {
					const { getBuiltinModels } = await import("@earendil-works/pi-ai/providers/all");
					const models = getBuiltinModels(entry.provider);
					if (Array.isArray(models)) catalogModelIds.set(entry.provider, new Set(models.map((model) => model.id)));
				} catch (error) {
					ctx.logger.warn(`[${name}] cannot read the pi-ai catalog for "${entry.provider}", treating it as declared`);
					ctx.logger.warn(error);
				}
			}
		}

		const { ops, injected } = planOps(user, declaredRoutes, catalogModelIds, levels);
		if (ops.length > 0) {
			try {
				await settings.mutate(NS, ops);
			} catch (error) {
				ctx.logger.error(`[${name}] publishing reasoningEfforts failed`);
				ctx.logger.error(error);
				return;
			}
			const targets = injected.map(({ route, model }) => `${route}/${model}`).join(", ");
			ctx.logger.info(`[${name}] published reasoningEfforts ${JSON.stringify(levels)} for ${injected.length} model(s): ${targets}`);
		}
		if (verify && injected.length > 0) {
			for (const { route, model } of injected) {
				try {
					const info = await ctx.llm.resolveModelInfo(route, model);
					ctx.logger.info(`[${name}] verify ${route}/${model}: reasoning=${JSON.stringify(info.reasoning ?? null)}`);
				} catch (error) {
					ctx.logger.warn(`[${name}] verify ${route}/${model} failed: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		}
	});

	// The adapter directory publishes after dsh-llm-pi-ai registers its
	// routes/namespace, and whenever that registration changes — this is the
	// event that catches a plugin start before pi-ai's own apply ran.
	ctx.on("llm/adapters-updated", refresh);
	// User edits through the settings UI or document, and this plugin's own
	// writes — the idempotence of planOps keeps this from ever looping.
	ctx.on("settings/updated", (ns) => {
		if (ns === NS) refresh();
	});
	ctx.on("settings/document-updated", (ns) => {
		if (ns === NS) refresh();
	});
	refresh();
}

//#endregion
export { Config, apply, inject, name };
