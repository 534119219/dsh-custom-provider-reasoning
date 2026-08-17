// Temporary diagnostic: capture the exact HTTP request pi-ai would send for
// the scnet route at each reasoning level, mirroring dsh-llm-pi-ai's
// materialization of the current settings. The model's baseUrl points at a
// local mock server so nothing leaves the machine; compat detection for an
// unknown host (api.scnet.cn) is identical to the mock's, so the request
// body is byte-for-byte what SCNet would receive.
import { createServer } from "node:http";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

const MOCK_PORT = 18923;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}/v1`;
const LEVELS = { off: null, low: "low", medium: "medium", high: "high", max: "max" };

// ---- local mock endpoint: capture POST bodies, answer with a canned SSE ----
const captured = [];
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    captured.push({ url: req.url, method: req.method, headers: req.headers, body: raw });
    const chunk = (delta, finish) =>
      `data: ${JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", model: "DeepSeek-V4-Pro", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end([chunk({ role: "assistant", content: "ok" }, null), chunk({}, "stop"), "data: [DONE]\n\n"].join(""));
  });
});
await new Promise((resolve) => server.listen(MOCK_PORT, "127.0.0.1", resolve));

// resolveModelReasoning: declared non-null levels → thinkingLevelMap; off
// stays absent (supported, send nothing).
const thinkingLevelMap = {};
for (const [level, wire] of Object.entries(LEVELS)) {
  if (wire !== null) thinkingLevelMap[level] = wire;
}

// resolveRouteModels for a hand-declared route (no catalog base): defaults
// contextWindow 262144 / maxTokens 32768, input ["text"], cost zeroed, plus
// the route-level compat now configured for scnet (thinkingFormat deepseek).
const makeModel = (id) => ({
  id,
  name: id,
  api: "openai-completions",
  provider: "scnet",
  baseUrl: MOCK_BASE,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 262144,
  maxTokens: 32768,
  reasoning: true,
  thinkingLevelMap: { ...thinkingLevelMap },
  compat: { thinkingFormat: "deepseek" },
});
const MODELS = ["DeepSeek-V4-Pro", "DeepSeek-V4-Flash-0731", "DeepSeek-V4-Flash"].map(makeModel);

// buildProvider + routeAuth for a hand-declared route with an apiKeyEnv:
// provider.auth = { apiKey: harnessApiKeyAuth(displayName) }.
const provider = createProvider({
  id: "scnet",
  name: "SCNet",
  baseUrl: MOCK_BASE,
  auth: {
    apiKey: {
      name: "SCNet",
      resolve: ({ credential }) => Promise.resolve({
        auth: credential?.key === void 0 ? {} : { apiKey: credential.key },
        source: "SCNet",
      }),
    },
  },
  models: MODELS,
  api: openAICompletionsApi(),
});

const models = createModels();
models.setProvider(provider);

const context = { messages: [{ role: "user", content: "ping" }] };

for (const reasoning of ["max", "high", "off", undefined]) {
  const before = captured.length;
  const options = {
    apiKey: "dummy",
    credential: { key: "dummy" },
    maxTokens: 32768,
    signal: new AbortController().signal,
  };
  if (reasoning !== void 0) options.reasoning = reasoning;
  const out = [];
  try {
    for await (const chunk of models.streamSimple(models.getModel("scnet", "DeepSeek-V4-Pro"), context, options)) {
      out.push(chunk);
    }
  } catch (error) {
    console.log(`\n===== reasoningEffort: ${reasoning ?? "(provider default)"} =====\nERROR: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    continue;
  }
  if (captured.length === before) {
    console.log(`\n===== reasoningEffort: ${reasoning ?? "(provider default)"} =====\n(NO REQUEST CAPTURED)`);
    continue;
  }
  const cap = captured[captured.length - 1];
  const body = JSON.parse(cap.body);
  const { authorization, ...restHeaders } = cap.headers;
  console.log(`\n===== reasoningEffort: ${reasoning ?? "(provider default)"} =====`);
  console.log("URL:    ", cap.url, "(mock; scnet path: /api/llm/v1/chat/completions)");
  console.log("Method: ", cap.method);
  console.log("Headers:", JSON.stringify(restHeaders, null, 2));
  console.log("BODY:");
  console.log(JSON.stringify(body, null, 2));
  console.log("streamed chunks:", out.length);
}

server.close();
