#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const explicitTarget = process.argv[2];
const dshCheckout = process.env.DSH_CHECKOUT;
const appData = process.env.APPDATA;

const candidates = [
	explicitTarget,
	process.env.DSH_LLM_PI_AI_INDEX,
	dshCheckout && path.join(dshCheckout, "packages", "dsh-llm-pi-ai", "lib", "index.js"),
	dshCheckout && path.join(dshCheckout, "node_modules", "@deepseek-ai", "dsh-llm-pi-ai", "lib", "index.js"),
	path.join(os.homedir(), ".dsh", "profiles", "node_modules", "@deepseek-ai", "dsh-llm-pi-ai", "lib", "index.js"),
	appData && path.join(appData, "npm", "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai", "dsh-llm-pi-ai", "lib", "index.js"),
].filter(Boolean);

const target = candidates.find((candidate) => fs.existsSync(candidate));
if (!target) {
	console.error("Could not find @deepseek-ai/dsh-llm-pi-ai/lib/index.js.");
	console.error("Pass its path as the first argument or set DSH_LLM_PI_AI_INDEX.");
	process.exit(1);
}

const resolvedTarget = fs.realpathSync(target);
const original = fs.readFileSync(resolvedTarget, "utf8");
let next = original;
const applied = [];
const alreadyPresent = [];

function replaceOnce(name, oldText, newText, isAlreadyPatched) {
	if (isAlreadyPatched(next)) {
		alreadyPresent.push(name);
		return;
	}
	const matches = next.split(oldText).length - 1;
	if (matches !== 1) {
		throw new Error(`${name}: expected exactly one unpatched match, found ${matches}; installed dsh-llm-pi-ai may have changed`);
	}
	next = next.replace(oldText, newText);
	applied.push(name);
}

try {
	replaceOnce(
		"listable-protocols",
		'const LISTABLE_PROTOCOLS = new Set(["openai-completions", "openai-responses"]);',
		'const LISTABLE_PROTOCOLS = new Set(["openai-completions", "openai-responses", "anthropic-messages"]);',
		(source) => /const LISTABLE_PROTOCOLS = new Set\(\[[^\]]*"anthropic-messages"/.test(source),
	);

	replaceOnce(
		"protocol-aware-listing-url",
		'function listingUrl(baseURL) {\n\treturn `${baseURL.replace(/\\/+$/, "")}/models`;\n}',
		'function listingUrl(baseURL, api) {\n\tconst base = baseURL.replace(/\\/+$/, "");\n\tif (api === "anthropic-messages") {\n\t\treturn base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;\n\t}\n\treturn `${base}/models`;\n}',
		(source) => source.includes('function listingUrl(baseURL, api)') && source.includes('if (api === "anthropic-messages")'),
	);

	replaceOnce(
		"listing-url-call",
		'\tconst url = listingUrl(request.baseURL);',
		'\tconst url = listingUrl(request.baseURL, api);',
		(source) => source.includes('\tconst url = listingUrl(request.baseURL, api);'),
	);

	replaceOnce(
		"anthropic-api-key-header",
		'\t\t\theaders: {\n\t\t\t\taccept: "application/json",\n\t\t\t\t...apiKey === void 0 ? {} : { authorization: `Bearer ${apiKey}` },\n\t\t\t\t...attributionHeaders()\n\t\t\t},',
		'\t\t\theaders: {\n\t\t\t\taccept: "application/json",\n\t\t\t\t...apiKey === void 0 ? {} : { authorization: `Bearer ${apiKey}` },\n\t\t\t\t...(api === "anthropic-messages" && apiKey !== void 0 ? { "x-api-key": apiKey } : {}),\n\t\t\t\t...attributionHeaders()\n\t\t\t},',
		(source) => source.includes('...(api === "anthropic-messages" && apiKey !== void 0 ? { "x-api-key": apiKey } : {}),'),
	);
} catch (error) {
	console.error(`Patch refused: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}

if (next === original) {
	console.log(`Already patched: ${resolvedTarget}`);
	console.log(`Markers present: ${alreadyPresent.join(", ")}`);
	process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = `${resolvedTarget}.bak-anthropic-discovery-${stamp}`;
fs.copyFileSync(resolvedTarget, backup);
fs.writeFileSync(resolvedTarget, next, "utf8");

console.log(`Patched: ${resolvedTarget}`);
console.log(`Backup:  ${backup}`);
console.log(`Applied: ${applied.join(", ")}`);
if (alreadyPresent.length > 0) console.log(`Already present: ${alreadyPresent.join(", ")}`);
console.log("Restart dsh, or hot-reload dsh-llm-pi-ai, before testing model discovery.");
