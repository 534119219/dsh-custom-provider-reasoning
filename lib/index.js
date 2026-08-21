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
 * lacks one, and backfills a missing `maxTokens` / `contextWindow` so a
 * hand-declared route does not inherit dsh's conservative 32768-token
 * default (which reasoning-heavy models such as DeepSeek V4 outgrow on the
 * reasoning output alone). Everything downstream — the `session.models` /
 * `llm.models` RPCs, request-time validation in `resolveCallConfig`, and the
 * wire translation (pi-ai sends `reasoning_effort` for OpenAI-compatible
 * endpoints) — then runs through the stock adapter unchanged.
 *
 * The plugin is protocol-aware. `reasoningEfforts` is protocol-agnostic (every
 * pi-ai protocol materializes it into `reasoning` + `thinkingLevelMap` and only
 * the wire spelling differs), but the route-level `compat.thinkingFormat` /
 * `supportsReasoningEffort` switches exist only on `openai-completions`. The
 * plugin strips those completions-only switches when the route speaks
 * `openai-responses` or `anthropic-messages`, and (when `thinkingFormat` is
 * configured) backfills it on DeepSeek-style completions routes. It does NOT
 * write `thinkingFormat` by default, because dsh-llm-pi-ai validates the
 * section on every write and a lingering `thinkingFormat` would make the very
 * protocol switch that should clear it get rejected first. It also pins
 * `compat.supportsDeveloperRole: false` on declared completions routes by
 * default — pi-ai otherwise assumes the developer role is supported and
 * new-api/one-api gateways reject `role: "developer"` with a 400.
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
 * covered, while genuine user configuration stays authoritative. The three
 * fields are decided independently: a model with a hand-tuned
 * `reasoningEfforts` still gets a missing `maxTokens` backfilled, and a model
 * whose `maxTokens` you set by hand keeps it untouched.
 * Injections are additive and idempotent: once a field is covered, no
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
	/**
	 * Backfill a missing `maxTokens` on qualifying model entries. A
	 * hand-declared route has no catalog entry to supply it, so without this
	 * dsh falls back to its 32768 default and reasoning-heavy models (DeepSeek
	 * V4 shares reasoning + content against maxTokens) hit `length` truncation.
	 * Set `false` to leave `maxTokens` untouched.
	 */
	maxTokens: z.union([z.number().step(1).min(1), z.const(false)]).default(384000),
	/** Same backfill for `contextWindow`; set `false` to leave it untouched. */
	contextWindow: z.union([z.number().step(1).min(1), z.const(false)]).default(1000000),
	/**
	 * Manage the route-level `compat.thinkingFormat` for DeepSeek-style models
	 * (id contains "deepseek"): write it on `openai-completions` routes that
	 * lack it, and strip the completions-only reasoning switches
	 * (`thinkingFormat` / `supportsReasoningEffort`) when the route speaks
	 * another protocol (`openai-responses` / `anthropic-messages`).
	 *
	 * Defaults to `false` (do NOT write `thinkingFormat`) because
	 * `dsh-llm-pi-ai` validates the section on every `settings.mutate`: a
	 * lingering `thinkingFormat` makes the route-to-another-protocol switch
	 * itself get rejected before this plugin can strip it. Set it to a wire
	 * spelling (e.g. `"deepseek"`) only for endpoints that genuinely require
	 * the DeepSeek `thinking` parameter; `false` disables the write while still
	 * stripping stale switches on other protocols.
	 */
	thinkingFormat: z.union([z.string(), z.const(false)]).default(false),
	/**
	 * Backfill `compat.supportsDeveloperRole` on declared completions routes
	 * while it is unset. pi-ai treats an unset flag as "the developer role is
	 * supported" for unknown endpoints, so it sends the system prompt as
	 * `role: "developer"` — which new-api/one-api-style gateways reject with
	 * a 400 (`unknown variant developer`). `false` (default) writes the flag
	 * as `false` so the adapter sends `system` instead; `true` opts a route
	 * back in. Manually-set values are never overwritten.
	 */
	supportsDeveloperRole: z.boolean().default(false),
	/**
	 * Manage the route-level default reasoning effort (`profile.reasoning`,
	 * which pi-ai surfaces as each model's `defaultEffort`): written when the
	 * route has none, so the model picker preselects this level and requests
	 * without an explicit effort use it. Existing values are never overwritten.
	 * Set `false` to leave the route default untouched.
	 */
	defaultEffort: z.union([z.const(false), ...THINKING_LEVELS]).default("max"),
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
 * Compute a route-level `compat` op. On `openai-completions`:
 * - a DeepSeek-style route gets `thinkingFormat` backfilled (so the adapter
 *   sends the DeepSeek `thinking` wire spelling instead of the OpenAI
 *   `reasoning_effort` default) when `thinkingFormat` is configured; and
 * - a declared route gets `supportsDeveloperRole` backfilled (default
 *   `false`, so the system prompt stays `system` rather than `developer`),
 *   because pi-ai otherwise assumes the developer role is supported.
 * On any other protocol the completions-only reasoning switches
 * (`thinkingFormat` / `supportsReasoningEffort`) are stripped so they cannot
 * fail resolution; `supportsDeveloperRole` and every other compat key are
 * left untouched.
 * @param route - provider route key.
 * @param compat - the current route-level compat value.
 * @param api - the route's resolved wire protocol.
 * @param isDeepSeek - whether any model id on the route names DeepSeek.
 * @param thinkingFormat - the thinkingFormat to backfill, or `false` to disable.
 * @param declared - whether the route is a hand-declared (non-catalog) provider.
 * @param supportsDeveloperRole - boolean value to backfill for declared routes.
 * @returns a mutate op, or null when no change is needed.
 */
function planCompatOp(route, compat, api, isDeepSeek, thinkingFormat, declared, supportsDeveloperRole) {
	const current = typeof compat === "object" && compat !== null && !Array.isArray(compat) ? compat : {};
	if (api === "openai-completions") {
		let next = null;
		if (thinkingFormat !== false && thinkingFormat !== void 0 && isDeepSeek && current.thinkingFormat === void 0) {
			next = { ...current, thinkingFormat };
		}
		if (declared && current.supportsDeveloperRole === void 0) {
			next = { ...(next ?? current), supportsDeveloperRole };
		}
		return next === null ? null : { op: "set", path: ["providers", route, "compat"], value: next };
	}
	if (current.thinkingFormat !== void 0 || current.supportsReasoningEffort !== void 0) {
		const next = { ...current };
		delete next.thinkingFormat;
		delete next.supportsReasoningEffort;
		return { op: "set", path: ["providers", route, "compat"], value: Object.keys(next).length > 0 ? next : null };
	}
	return null;
}

/**
 * Compute the settings ops that give every qualifying model entry a
 * `reasoningEfforts` declaration and backfill a missing `maxTokens` /
 * `contextWindow`, without touching anything else in the section. Each field
 * is decided independently, so a model that already carries a hand-tuned
 * `reasoningEfforts` still gets its missing limits backfilled (and vice
 * versa). One whole-`models`-array op per affected route (the settings mutate
 * seam cannot walk array elements, and this is the same shape the settings UI
 * itself persists).
 * @param user - the raw user section of the llm-pi-ai namespace.
 * @param declaredRoutes - provider ids pi-ai does not ship.
 * @param catalogModelIds - map of route → catalog model id set, or null when
 *   catalog routes are out of scope.
 * @param levels - validated levels dict to inject.
 * @param maxTokens - value to backfill when `entry.maxTokens` is missing, or
 *   `false` to leave it untouched.
 * @param contextWindow - value to backfill when `entry.contextWindow` is
 *   missing, or `false` to leave it untouched.
 * @returns `{ ops, injected }` — ordered mutate ops and the route/model ids
 *   they cover; ops is empty when nothing to do.
 */
function planOps(user, declaredRoutes, catalogModelIds, levels, maxTokens, contextWindow, thinkingFormat, defaultEffort, supportsDeveloperRole) {
	const ops = [];
	const injected = [];
	const providers = user?.providers;
	if (typeof providers !== "object" || providers === null || Array.isArray(providers)) return { ops, injected };
	for (const [route, profile] of Object.entries(providers)) {
		if (typeof profile !== "object" || profile === null || Array.isArray(profile)) continue;
		const declared = declaredRoutes.has(route);
		if (!declared && catalogModelIds === null) continue;
		const api = profile.api;
		const models = profile.models;
		let next = null; // lazily cloned array, only when at least one entry qualifies
		let isDeepSeek = false;
		if (Array.isArray(models)) {
			for (let index = 0; index < models.length; index++) {
				const entry = models[index];
				if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
				if (typeof entry.id === "string" && entry.id.toLowerCase().includes("deepseek")) isDeepSeek = true;
				if (!declared) {
					// `all` scope on a catalog route: only cover ids the installed
					// catalog does not describe; catalog-described models keep the
					// catalog's own reasoning metadata.
					const known = catalogModelIds?.get(route);
					if (known?.has(entry.id)) continue;
				}
				const patch = {};
				// A hand-tuned dict or an explicit `false` wins — with one
				// exception: a dict this plugin itself wrote from the built-in
				// default is plugin-owned, so it is refreshed when the configured
				// `levels` change. That is what makes raising `levels` in the
				// patch config reach every provider the plugin already covered.
				// `reasoningEfforts` is protocol-agnostic: every pi-ai protocol
				// materializes it into `reasoning` + `thinkingLevelMap` and only
				// the wire spelling differs.
				const existingReasoning = entry.reasoningEfforts;
				if (existingReasoning === void 0 || (deepEqualPlain(existingReasoning, DEFAULT_LEVELS) && !deepEqualPlain(levels, DEFAULT_LEVELS))) {
					patch.reasoningEfforts = { ...levels };
				}
				if (entry.maxTokens === void 0 && maxTokens !== void 0 && maxTokens !== false) {
					patch.maxTokens = maxTokens;
				}
				if (entry.contextWindow === void 0 && contextWindow !== void 0 && contextWindow !== false) {
					patch.contextWindow = contextWindow;
				}
				if (Object.keys(patch).length === 0) continue;
				next ??= models.map((model) =>
					typeof model === "object" && model !== null && !Array.isArray(model) ? { ...model } : model
				);
				next[index] = { ...next[index], ...patch };
				injected.push({ route, model: entry.id });
			}
		}
		if (next !== null) ops.push({ op: "set", path: ["providers", route, "models"], value: next });
		// Protocol-aware route-level compat: backfill the DeepSeek thinking
		// spelling on completions, strip the completions-only switches on any
		// other protocol so switching never leaves stale switches behind.
		const compatOp = planCompatOp(route, profile.compat, api, isDeepSeek, thinkingFormat, declared, supportsDeveloperRole);
		if (compatOp !== null) ops.push(compatOp);
		// Route-level default effort: written only when absent, so a value the
		// user set (or this plugin already wrote) stays authoritative.
		if (defaultEffort !== void 0 && defaultEffort !== false && profile.reasoning === void 0) {
			ops.push({ op: "set", path: ["providers", route, "reasoning"], value: defaultEffort });
		}
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
	const { enabled = true, scope = "declared", levels = DEFAULT_LEVELS, verify = false, maxTokens = 384000, contextWindow = 1000000, thinkingFormat = false, defaultEffort = "max", supportsDeveloperRole = false } = config;
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

		const { ops, injected } = planOps(user, declaredRoutes, catalogModelIds, levels, maxTokens, contextWindow, thinkingFormat, defaultEffort, supportsDeveloperRole);
		if (ops.length > 0) {
			try {
				await settings.mutate(NS, ops);
			} catch (error) {
				ctx.logger.error(`[${name}] publishing model metadata failed`);
				ctx.logger.error(error);
				return;
			}
			const targets = injected.map(({ route, model }) => `${route}/${model}`).join(", ");
			ctx.logger.info(`[${name}] backfilled model metadata for ${injected.length} model(s): ${targets}`);
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
