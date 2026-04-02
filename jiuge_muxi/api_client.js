const CHAT_PATHS = ["/chat/completions", "/v1/chat/completions"];
const ENV_URL_KEYS = ["OPENAI_API_URL", "API_URL", "LLM_API_URL"];

function unique(values) {
    return [...new Set(values.filter(Boolean))];
}

function normalizeOriginVariants(hostname) {
    if (hostname === "localhost") return ["localhost", "127.0.0.1"];
    if (hostname === "127.0.0.1") return ["127.0.0.1", "localhost"];
    return [hostname];
}

function expandEndpoint(rawUrl) {
    if (!rawUrl) return [];

    try {
        const url = new URL(rawUrl);
        const pathVariants = unique([url.pathname, ...CHAT_PATHS]);
        const hostVariants = normalizeOriginVariants(url.hostname);
        const variants = [];

        for (const hostname of hostVariants) {
            for (const pathname of pathVariants) {
                const next = new URL(url.toString());
                next.hostname = hostname;
                next.pathname = pathname;
                variants.push(next.toString());
            }
        }

        return unique([url.toString(), ...variants]);
    } catch {
        return [rawUrl];
    }
}

function buildEndpointCandidates(preferredUrl) {
    const envUrls = ENV_URL_KEYS.map((key) => process.env[key]);
    const fallbackUrls = [
        "http://172.22.162.17:8000/chat/completions",
        "http://172.22.162.17:8000/v1/chat/completions",
        "http://127.0.0.1:8000/chat/completions",
        "http://127.0.0.1:8000/v1/chat/completions",
        "http://localhost:8000/chat/completions",
        "http://localhost:8000/v1/chat/completions"
    ];

    const allUrls = [preferredUrl, ...envUrls, ...fallbackUrls];
    return unique(allUrls.flatMap(expandEndpoint));
}

function formatSocketError(err) {
    if (!err) return "";
    const code = err.code || "ERROR";
    const address = err.address || err.host || "unknown-host";
    const port = err.port ? `:${err.port}` : "";
    return `${code} ${address}${port}`;
}

function formatFetchError(error, timeoutMs) {
    if (!error) return "unknown error";

    if (error.name === "AbortError") {
        return `timeout after ${timeoutMs} ms`;
    }

    const nestedErrors = error.cause?.errors;
    if (Array.isArray(nestedErrors) && nestedErrors.length > 0) {
        return nestedErrors.map(formatSocketError).join(", ");
    }

    if (error.cause?.code || error.cause?.address) {
        return formatSocketError(error.cause);
    }

    if (error.code || error.address) {
        return formatSocketError(error);
    }

    return error.message || String(error);
}

async function fetchWithTimeout(resource, options = {}) {
    const { timeout = 8000, ...restOptions } = options;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        return await fetch(resource, { ...restOptions, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function readBodySnippet(response) {
    try {
        const text = await response.text();
        return text.replace(/\s+/g, " ").trim().slice(0, 240);
    } catch {
        return "";
    }
}

async function openChatCompletionStream({ preferredUrl, payload, timeoutMs }) {
    const endpoints = buildEndpointCandidates(preferredUrl);
    const attempts = [];

    for (const endpoint of endpoints) {
        try {
            const response = await fetchWithTimeout(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
                timeout: timeoutMs
            });

            if (!response.ok) {
                const bodySnippet = await readBodySnippet(response);
                attempts.push(
                    `${endpoint} -> HTTP ${response.status}${bodySnippet ? ` | ${bodySnippet}` : ""}`
                );
                continue;
            }

            if (!response.body) {
                attempts.push(`${endpoint} -> empty response body`);
                continue;
            }

            return { response, endpoint };
        } catch (error) {
            attempts.push(`${endpoint} -> ${formatFetchError(error, timeoutMs)}`);
        }
    }

    const lines = attempts.length > 0
        ? attempts.map((item, index) => `  ${index + 1}. ${item}`).join("\n")
        : "  1. No candidate endpoints generated.";
    const error = new Error(`All API endpoints failed.\n${lines}`);
    error.attempts = attempts;
    throw error;
}

module.exports = {
    buildEndpointCandidates,
    fetchWithTimeout,
    formatFetchError,
    openChatCompletionStream
};
