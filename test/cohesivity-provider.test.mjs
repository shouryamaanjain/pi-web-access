import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const cohesivityModuleUrl = new URL("../cohesivity.ts", import.meta.url).href;
const searchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;
const activityModuleUrl = new URL("../activity.ts", import.meta.url).href;
const curatorPageModuleUrl = new URL("../curator-page.ts", import.meta.url).href;
const KEY = "coh_app_test0key0abc123xyz9";

async function withHome(config, run) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-cohesivity-"));
	try {
		await writeFile(join(home, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
		return await run(home);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}

function runChild(script, env = {}, cwd = env.PI_CODING_AGENT_DIR) {
	const childEnv = { ...process.env };
	// Drop every provider credential and endpoint so only the mocked fetch decides availability.
	for (const key of Object.keys(childEnv)) {
		if (key === "PI_CODING_AGENT_DIR" || key === "XDG_CONFIG_HOME" || /(?:_KEY|_TOKEN|_BASE_URL)$/.test(key)) delete childEnv[key];
	}
	// HOME and the working directory are sandboxed too, so no real .cohesivity file is ever found.
	if (env.PI_CODING_AGENT_DIR) childEnv.HOME = env.PI_CODING_AGENT_DIR;
	Object.assign(childEnv, env);
	const child = spawnSync(process.execPath, ["--input-type=module"], { input: script, encoding: "utf8", env: childEnv, cwd, maxBuffer: 2 * 1024 * 1024 });
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim());
}

const envelope = (results) => JSON.stringify({ requestId: "r1", resolvedSearchType: "neural", results, searchTime: 120, costDollars: { total: 0.005 } });
const apiError = (code, message) => JSON.stringify({ error: { code, message: `[Cohesivity] ${message}` } });

test("Cohesivity posts the query with the key as a URL parameter and maps highlights", () => withHome({ cohesivityApplicationKey: KEY }, async (home) => {
	const output = runChild(`
		let captured;
		globalThis.fetch = async (url, init) => {
			captured = { url: String(url), method: init.method, redirect: init.redirect, headers: { ...init.headers }, body: JSON.parse(init.body) };
			return new Response(${JSON.stringify(envelope([
				{ id: "1", title: " Paper ", url: "https://example.com/paper", publishedDate: "2026-10-01T00:00:00.000Z", highlights: ["First line\n\n  second   line", "x".repeat(800)] },
				{ id: "2", title: "Again", url: "https://example.com/paper", highlights: ["duplicate"] },
				{ id: "3", title: "", url: "https://example.net/untitled" },
				{ id: "4", title: "Summary only", url: "https://example.org/summary", summary: "A summary" },
				{ id: "5", title: "File", url: "file:///tmp/result", highlights: ["skipped"] },
			]))}, { status: 200 });
		};
		const { searchWithCohesivity, isCohesivityAvailable } = await import(${JSON.stringify(cohesivityModuleUrl)});
		const result = await searchWithCohesivity("node release", { numResults: 50, recencyFilter: "week" });
		console.log(JSON.stringify({ captured, available: isCohesivityAvailable(), result }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(output.available, true);
	const { COHESIVITY_SEARCH_URL } = await import(cohesivityModuleUrl);
	const sent = new URL(output.captured.url);
	assert.equal(`${sent.origin}${sent.pathname}`, COHESIVITY_SEARCH_URL);
	assert.deepEqual([...sent.searchParams], [["key", KEY]]);
	assert.equal(output.captured.method, "POST");
	assert.equal(output.captured.redirect, "manual");
	assert.equal(output.captured.headers["User-Agent"], "pi-web-access");
	assert.doesNotMatch(JSON.stringify(output.captured.headers), new RegExp(KEY));
	const { startPublishedDate, ...rest } = output.captured.body;
	assert.deepEqual(rest, { query: "node release", numResults: 20, type: "auto", contents: { highlights: { numSentences: 2 } } });
	const ageDays = (Date.now() - Date.parse(startPublishedDate)) / 86_400_000;
	assert.ok(ageDays >= 7 && ageDays < 7.01, `startPublishedDate should be a week back, got ${startPublishedDate}`);
	const [paper, untitled, summary, ...others] = output.result.results;
	assert.equal(paper.title, "Paper");
	assert.equal(paper.snippet.length, 500);
	assert.ok(paper.snippet.startsWith("First line second line x"));
	assert.deepEqual(untitled, { title: "Source 2", url: "https://example.net/untitled", snippet: "" });
	assert.equal(summary.snippet, "A summary");
	assert.deepEqual(others, []);
	assert.match(output.result.answer, /Source: Paper \(https:\/\/example\.com\/paper\)/);
	assert.doesNotMatch(JSON.stringify(output.result), new RegExp(KEY));
}));

test("COHESIVITY_APPLICATION_KEY takes precedence over the config value", async () => {
	for (const [config, env, expected] of [
		[{ cohesivityApplicationKey: "coh_app_configkey0000000000" }, { COHESIVITY_APPLICATION_KEY: "coh_app_envkey000000000000" }, "coh_app_envkey000000000000"],
		[{ cohesivityApplicationKey: "$MY_COH_KEY" }, { MY_COH_KEY: "coh_app_named0000000000000", COHESIVITY_APPLICATION_KEY: "coh_app_envkey000000000000" }, "coh_app_named0000000000000"],
	]) {
		await withHome(config, (home) => {
			const output = runChild(`
				let key;
				globalThis.fetch = async (url) => { key = new URL(String(url)).searchParams.get("key"); return new Response(${JSON.stringify(envelope([]))}); };
				const { searchWithCohesivity } = await import(${JSON.stringify(cohesivityModuleUrl)});
				const result = await searchWithCohesivity("q");
				console.log(JSON.stringify({ key, results: result.results }));
			`, { PI_CODING_AGENT_DIR: home, ...env });
			assert.equal(output.key, expected);
			assert.deepEqual(output.results, []);
		});
	}
});

test("Cohesivity sends domain filters natively and reapplies them locally", () => withHome({ cohesivityApplicationKey: KEY }, (home) => {
	const output = runChild(`
		const bodies = [];
		globalThis.fetch = async (_url, init) => {
			bodies.push(JSON.parse(init.body));
			return new Response(${JSON.stringify(envelope([
				{ title: "Allowed", url: "https://docs.example.com/a", highlights: ["a"] },
				{ title: "Excluded", url: "https://private.docs.example.com/b", highlights: ["b"] },
				{ title: "Outside", url: "https://example.net/c", highlights: ["c"] },
				{ title: "Other allowed", url: "https://example.org/d", highlights: ["d"] },
			]))});
		};
		const { searchWithCohesivity } = await import(${JSON.stringify(cohesivityModuleUrl)});
		const single = await searchWithCohesivity("single", { domainFilter: ["https://example.com/"], numResults: 3 });
		const several = await searchWithCohesivity("several", { domainFilter: ["example.com", "example.org", "-private.docs.example.com", "-not a domain"], numResults: 3 });
		console.log(JSON.stringify({ bodies, single: single.results.map(r => r.url), several: several.results.map(r => r.url) }));
	`, { PI_CODING_AGENT_DIR: home });
	const [singleBody, severalBody] = output.bodies;
	assert.deepEqual(singleBody.includeDomains, ["example.com"]);
	assert.equal(singleBody.excludeDomains, undefined);
	assert.equal(singleBody.startPublishedDate, undefined);
	assert.equal(singleBody.query, "single");
	assert.equal(singleBody.numResults, 3);
	assert.deepEqual(severalBody.includeDomains, ["example.com", "example.org"]);
	assert.deepEqual(severalBody.excludeDomains, ["private.docs.example.com"]);
	assert.deepEqual(output.single, ["https://docs.example.com/a", "https://private.docs.example.com/b"]);
	assert.deepEqual(output.several, ["https://docs.example.com/a", "https://example.org/d"]);
}));

test("Cohesivity is selectable explicitly, in provider arrays, and in searchRouting, but excluded from auto and provider all", async () => {
	await withHome({ cohesivityApplicationKey: KEY }, (home) => {
		const output = runChild(`
			const calls = [];
			globalThis.fetch = async (url) => {
				const target = String(url);
				calls.push(target);
				if (target.startsWith("https://cohesivity.ai/")) return new Response(${JSON.stringify(envelope([{ title: "Cohesivity", url: "https://example.com", highlights: ["result"] }]))});
				// Every other provider fails, so auto and all can only succeed by using Cohesivity.
				return new Response("unavailable", { status: 503 });
			};
			const { search } = await import(${JSON.stringify(searchModuleUrl)});
			const explicit = await search("explicit", { provider: "cohesivity" });
			const array = await search("array", { provider: ["cohesivity"] });
			const before = calls.length;
			const outcomes = [];
			for (const provider of ["auto", "all"]) {
				try { outcomes.push((await search(provider, { provider })).provider ?? "aggregate"); } catch { outcomes.push("failed"); }
			}
			console.log(JSON.stringify({ explicitProvider: explicit.provider, arrayProviders: array.providerResponses.map(result => result.provider), outcomes, laterCalls: calls.slice(before), calls }));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(output.explicitProvider, "cohesivity");
		assert.deepEqual(output.arrayProviders, ["cohesivity"]);
		assert.deepEqual(output.outcomes, ["failed", "failed"]);
		assert.ok(output.laterCalls.length > 0, "auto and all should have tried other providers");
		assert.equal(output.laterCalls.filter(url => url.startsWith("https://cohesivity.ai/")).length, 0);
		assert.equal(output.calls.filter(url => url.startsWith("https://cohesivity.ai/")).length, 2);
	});

	await withHome({
		cohesivityApplicationKey: KEY,
		braveApiKey: "brave-test-key",
		searchRouting: { providers: ["cohesivity", "brave"], fallbackOn: ["quota"] },
	}, (home) => {
		const output = runChild(`
			const calls = [];
			globalThis.fetch = async (url) => {
				const target = String(url);
				calls.push(new URL(target).hostname);
				if (target.startsWith("https://cohesivity.ai/")) return new Response(${JSON.stringify(apiError(429, "Rate limit exceeded"))}, { status: 429 });
				if (target.startsWith("https://api.search.brave.com/res/v1/web/search")) {
					return new Response(JSON.stringify({ web: { results: [{ title: "Brave", url: "https://example.com/brave", description: "fallback" }] } }), { status: 200 });
				}
				throw new Error("Unexpected fetch " + target);
			};
			const { search } = await import(${JSON.stringify(searchModuleUrl)});
			const routed = await search("limited", { provider: "auto" });
			console.log(JSON.stringify({ provider: routed.provider, routed, calls }));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(output.provider, "brave");
		assert.deepEqual(output.calls, ["cohesivity.ai", "api.search.brave.com"]);
		assert.doesNotMatch(JSON.stringify(output.routed), new RegExp(KEY));
	});
});

test("Cohesivity errors name the provider and status, give hints, and never contain the key", () => withHome({ cohesivityApplicationKey: KEY }, (home) => {
	const output = runChild(`
		const responses = [
			() => new Response(${JSON.stringify(apiError(400, "Missing authentication"))}, { status: 400 }),
			() => new Response(${JSON.stringify(apiError(401, "Invalid application key"))}, { status: 401 }),
			() => new Response(${JSON.stringify(apiError(403, "Service not provisioned"))}, { status: 403 }),
			() => new Response(${JSON.stringify(apiError(403, "Search type 'deep' is not allowed"))}, { status: 403 }),
			() => new Response(${JSON.stringify(apiError(429, "Rate limit exceeded"))}, { status: 429 }),
			// A hostile or buggy upstream that echoes the request URL must still be redacted.
			(url) => new Response("upstream failure for " + url, { status: 502 }),
			(url) => { throw new TypeError("fetch failed for " + url, { cause: new Error("connect ECONNREFUSED " + url) }); },
			() => new Response(JSON.stringify({ requestId: "r" }), { status: 200 }),
			() => new Response("not json", { status: 200 }),
		];
		globalThis.fetch = async (url) => responses.shift()(String(url));
		const { searchWithCohesivity } = await import(${JSON.stringify(cohesivityModuleUrl)});
		const { activityMonitor } = await import(${JSON.stringify(activityModuleUrl)});
		const errors = [];
		for (let i = 0; i < 9; i++) {
			try { await searchWithCohesivity("broken"); } catch (error) { errors.push({ text: String(error), cause: error.cause === undefined ? null : String(error.cause), name: error.name }); }
		}
		console.log(JSON.stringify({ errors, activity: activityMonitor.getEntries() }));
	`, { PI_CODING_AGENT_DIR: home });
	const [missing, invalid, unprovisioned, blocked, limited, echoed, network, malformed, json] = output.errors;
	assert.equal(missing.text, "Error: Cohesivity search error 400: Missing authentication");
	assert.match(invalid.text, /^Error: Cohesivity search error 401: Invalid application key \(check that cohesivityApplicationKey or COHESIVITY_APPLICATION_KEY is the coh_application_key/);
	assert.match(unprovisioned.text, /^Error: Cohesivity search error 403: Service not provisioned \(search must be provisioned once .*ask your coding agent/);
	assert.equal(blocked.text, "Error: Cohesivity search error 403: Search type 'deep' is not allowed");
	assert.match(limited.text, /^Error: Cohesivity search error 429: Rate limit exceeded \(rate limited; anonymous projects allow 5 search requests per minute/);
	assert.match(echoed.text, /^Error: Cohesivity search error 502: upstream failure for .*key=\[redacted\]/);
	assert.match(network.text, /^TypeError: fetch failed for .*key=\[redacted\]/);
	assert.equal(network.cause, null);
	assert.match(malformed.text, /Cohesivity search returned invalid response: expected results array/);
	assert.match(json.text, /Cohesivity search returned invalid JSON/);
	assert.doesNotMatch(JSON.stringify(output), new RegExp(KEY));
	assert.ok(output.activity.some(entry => /error 401/.test(entry.error ?? "")));
}));

test("Cohesivity routing diagnostics for a failed named provider never contain the key", () => withHome({ cohesivityApplicationKey: KEY }, (home) => {
	const output = runChild(`
		globalThis.fetch = async (url) => { throw new TypeError("fetch failed for " + url); };
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		let failure;
		try { await search("q", { provider: "cohesivity" }); } catch (error) { failure = { text: String(error), json: JSON.stringify(error, Object.getOwnPropertyNames(error)), cause: String(error.cause?.message ?? "") }; }
		console.log(JSON.stringify(failure));
	`, { PI_CODING_AGENT_DIR: home });
	assert.match(output.text, /fetch failed/);
	assert.doesNotMatch(JSON.stringify(output), new RegExp(KEY));
}));

test("Cohesivity refuses redirects so the key never reaches another URL", () => withHome({ cohesivityApplicationKey: KEY }, (home) => {
	const output = runChild(`
		const calls = [];
		const locations = ["https://collector.example/steal?key=" + ${JSON.stringify(KEY)}, "/edge/moved"];
		globalThis.fetch = async (url, init) => {
			calls.push({ target: String(url), redirect: init.redirect });
			if (calls.length <= 2) return new Response(null, { status: 307, headers: { location: locations[calls.length - 1] } });
			return new Response(${JSON.stringify(envelope([]))});
		};
		const { searchWithCohesivity } = await import(${JSON.stringify(cohesivityModuleUrl)});
		const errors = [];
		for (let i = 0; i < 2; i++) {
			try { await searchWithCohesivity("redirect"); } catch (error) { errors.push(String(error)); }
		}
		console.log(JSON.stringify({ calls: calls.map(call => ({ origin: new URL(call.target).origin, redirect: call.redirect })), errors }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.deepEqual(output.calls, [
		{ origin: "https://cohesivity.ai", redirect: "manual" },
		{ origin: "https://cohesivity.ai", redirect: "manual" },
	]);
	assert.deepEqual(output.errors, [
		"Error: Cohesivity search error 307: refused an unexpected redirect",
		"Error: Cohesivity search error 307: refused an unexpected redirect",
	]);
}));

test("Cohesivity appears in the Curator", async () => {
	const { generateCuratorPage } = await import(curatorPageModuleUrl);
	const available = new Proxy({ all: false, cohesivity: true }, { get: (target, property) => target[property] ?? false });
	const page = generateCuratorPage(["query"], "token", 20, available, "cohesivity", "cohesivity", [], null);
	assert.match(page, /data-provider="cohesivity"/);
	assert.match(page, />Cohesivity<\/button>/);
	assert.match(page, /provider === "cohesivity"\) return "Cohesivity"/);
});

// ---- Zero-setup credentials: project .cohesivity files and the anonymous tenant pi-web-access owns ----

const AUTO = (n) => ({ tenantId: `tenant-${n}`, managementKey: `coh_man_auto${n}secret0000000`, applicationKey: `coh_app_auto${n}secret0000000` });
const PROJECT = { tenantId: "project-tenant", managementKey: "coh_man_project0secret00000", applicationKey: "coh_app_project0secret00000" };
const APPROVAL_TOKEN = "claimtoken0secret0abc";
const APPROVAL_URL = `https://cohesivity.ai/c/${APPROVAL_TOKEN}`;
const SECRETS = [KEY, PROJECT.managementKey, PROJECT.applicationKey, APPROVAL_TOKEN, ...[1, 2, 9].flatMap(n => [AUTO(n).managementKey, AUTO(n).applicationKey])];

// Runs inside the child: a fake hosted MCP server and search endpoint behind globalThis.fetch.
function installHarness() {
	const future = () => new Date(Date.now() + 72 * 3_600_000).toISOString();
	const h = { calls: [], created: 0, sse: new Set(), approvalUrl: "https://cohesivity.ai/c/claimtoken0secret0abc" };
	h.keys = (n) => ({ tenantId: `tenant-${n}`, managementKey: `coh_man_auto${n}secret0000000`, applicationKey: `coh_app_auto${n}secret0000000` });
	h.toolError = (text) => ({ content: [{ type: "text", text }], isError: true });
	h.edgeError = (status, message, extra = {}) => new Response(JSON.stringify({ error: { code: status, message: `[Cohesivity] ${message}` }, ...extra }), { status, headers: { "Content-Type": "application/json" } });
	h.rpc = (tool, result) => {
		const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result });
		return h.sse.has(tool)
			? new Response(`event: message\ndata: ${body}\n\n`, { headers: { "Content-Type": "text/event-stream" } })
			: new Response(body, { headers: { "Content-Type": "application/json" } });
	};
	h.handlers = {
		create_tenant: () => {
			const k = h.keys(++h.created);
			const expiresAt = future();
			const content = `# .cohesivity\n# coh_application_key=not-this-one\ntenant_id=${k.tenantId}\ncoh_management_key=${k.managementKey}\ncoh_application_key=${k.applicationKey}\nexpires_at=${expiresAt}\ntenant_lifecycle=ephemeral\n`;
			return { structuredContent: { tenant_id: k.tenantId, expires_at: expiresAt, runtime_profile: "stable", tenant_lifecycle: "ephemeral", credentials_file: { filename: ".cohesivity", content } } };
		},
		provision_resource: (args) => ({ structuredContent: { resource: args.resource, result: { success: true, status: "active" } } }),
		tenant_status: () => ({ structuredContent: { status: { account: { status: "active", lifecycle: "ephemeral", expires_at: future() }, bucket_usage: { "exa-api": { requests_used_all_time: 1, requests_limit_all_time: 50, requests_per_minute_limit: 5 } } } } }),
		claim_tenant: (args) => ({ structuredContent: { tenant_id: args.tenant_id, approval_url: h.approvalUrl } }),
	};
	h.edge = () => new Response(JSON.stringify({ results: [{ title: "Hit", url: "https://example.com/hit", highlights: ["found"] }] }));
	globalThis.fetch = async (url, init) => {
		const target = String(url);
		if (target === "https://cohesivity.ai/mcp") {
			const message = JSON.parse(init.body);
			const call = { kind: "mcp", tool: message.params.name, args: message.params.arguments, method: message.method, headers: { ...init.headers }, redirect: init.redirect };
			h.calls.push(call);
			const outcome = await h.handlers[call.tool](call.args);
			return outcome instanceof Response ? outcome : h.rpc(call.tool, outcome);
		}
		if (target.startsWith("https://cohesivity.ai/edge/exa-api/search?")) {
			const key = new URL(target).searchParams.get("key");
			h.calls.push({ kind: "search", key });
			return h.edge(key, h.calls.filter(call => call.kind === "search").length);
		}
		throw new Error("unexpected fetch " + target);
	};
	h.tools = () => h.calls.filter(call => call.kind === "mcp").map(call => call.tool);
	h.searchKeys = () => h.calls.filter(call => call.kind === "search").map(call => call.key);
	return h;
}

const childScript = (body) => `
	const h = (${installHarness.toString()})();
	const { searchWithCohesivity, isCohesivityAvailable } = await import(${JSON.stringify(cohesivityModuleUrl)});
	const { activityMonitor } = await import(${JSON.stringify(activityModuleUrl)});
	const errorOf = async (promise) => { try { await promise; return null; } catch (error) { return { text: String(error), name: error.name, cause: error.cause === undefined ? null : String(error.cause) }; } };
	const done = (extra) => console.log(JSON.stringify({ tools: h.tools(), searchKeys: h.searchKeys(), mcp: h.calls.filter(call => call.kind === "mcp"), activity: activityMonitor.getEntries(), ...extra }));
	${body}
`;

// A sandbox HOME holding the Pi agent dir, plus a project directory nested inside it.
async function withSandbox(run) {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-cohesivity-"));
	const home = join(root, "home");
	const agentDir = join(home, ".pi", "agent");
	const workspace = join(home, "work");
	const project = join(workspace, "project");
	await mkdir(project, { recursive: true });
	try {
		return await run({ home, agentDir, workspace, project, statePath: join(agentDir, "cohesivity-tenant.json"), env: { PI_CODING_AGENT_DIR: agentDir, HOME: home } });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function exists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function writeState(box, tenant, expiresAt) {
	await mkdir(box.agentDir, { recursive: true });
	await writeFile(box.statePath, JSON.stringify({ tenant_id: tenant.tenantId, coh_management_key: tenant.managementKey, coh_application_key: tenant.applicationKey, expires_at: expiresAt }), { mode: 0o600 });
}

const inHours = (hours) => new Date(Date.now() + hours * 3_600_000).toISOString();
const projectFile = (values = PROJECT) => [
	"# .cohesivity — Cohesivity tenant credentials and guidelines.",
	"# coh_application_key=commented-out",
	"",
	`tenant_id=${values.tenantId}`,
	`coh_management_key=${values.managementKey}`,
	`coh_application_key=${values.applicationKey}`,
	`expires_at=${inHours(48)}`,
	"tenant_lifecycle=ephemeral",
	"",
].join("\n");

function assertNoSecrets(value, allowed = []) {
	const text = JSON.stringify(value);
	for (const secret of SECRETS) {
		if (!allowed.includes(secret)) assert.doesNotMatch(text, new RegExp(secret), `leaked ${secret}`);
	}
}

test("Cohesivity with nothing configured is available and creates one tenant for concurrent searches, then reuses the saved state", () => withSandbox(async (box) => {
	const first = runChild(childScript(`
		// create_tenant answers as SSE, provision_resource as plain JSON.
		h.sse.add("create_tenant");
		const available = isCohesivityAvailable();
		const responses = await Promise.all([1, 2, 3].map(i => searchWithCohesivity("query " + i)));
		done({ available, results: responses.map(response => response.results.map(result => result.url)) });
	`), box.env, box.project);
	assert.equal(first.available, true);
	assert.deepEqual(first.tools, ["create_tenant", "provision_resource"]);
	assert.deepEqual(first.mcp[0].args, { confirmed: true });
	assert.deepEqual(first.mcp[1].args, { tenant_id: "tenant-1", resource: "exa-api", confirmed: true, coh_management_key: AUTO(1).managementKey });
	for (const call of first.mcp) {
		assert.equal(call.method, "tools/call");
		assert.equal(call.redirect, "manual");
		assert.deepEqual(call.headers, { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "User-Agent": "pi-web-access" });
	}
	assert.deepEqual(first.searchKeys, Array(3).fill(AUTO(1).applicationKey));
	assert.deepEqual(first.results, Array(3).fill(["https://example.com/hit"]));
	assertNoSecrets([first.activity, first.results]);

	const info = await stat(box.statePath);
	assert.equal(info.mode & 0o777, 0o600);
	const saved = JSON.parse(await readFile(box.statePath, "utf8"));
	assert.deepEqual(Object.keys(saved).sort(), ["coh_application_key", "coh_management_key", "expires_at", "tenant_id"]);
	assert.equal(saved.tenant_id, "tenant-1");
	assert.equal(saved.coh_management_key, AUTO(1).managementKey);
	assert.equal(saved.coh_application_key, AUTO(1).applicationKey);
	assert.ok(Date.parse(saved.expires_at) > Date.now());
	const { readdir } = await import("node:fs/promises");
	assert.deepEqual(await readdir(box.agentDir), ["cohesivity-tenant.json"]);

	const second = runChild(childScript(`
		await searchWithCohesivity("again");
		done({});
	`), box.env, box.project);
	assert.deepEqual(second.tools, []);
	assert.deepEqual(second.searchKeys, [AUTO(1).applicationKey]);
}));

test("Cohesivity uses an explicit key or a project .cohesivity from a parent directory without bootstrapping or writing state", () => withSandbox(async (box) => {
	const projectPath = join(box.workspace, ".cohesivity");
	await writeFile(projectPath, projectFile(), { mode: 0o600 });
	const before = await stat(projectPath);
	const beforeContent = await readFile(projectPath, "utf8");
	const script = childScript(`
		await searchWithCohesivity("q");
		done({});
	`);

	const explicit = runChild(script, { ...box.env, COHESIVITY_APPLICATION_KEY: KEY }, box.project);
	assert.deepEqual(explicit.tools, []);
	assert.deepEqual(explicit.searchKeys, [KEY]);

	const project = runChild(script, box.env, box.project);
	assert.deepEqual(project.tools, []);
	assert.deepEqual(project.searchKeys, [PROJECT.applicationKey]);
	assert.equal(await exists(box.statePath), false);

	// A project file also wins over a saved anonymous tenant.
	await writeState(box, AUTO(1), inHours(10));
	const overState = runChild(script, box.env, box.project);
	assert.deepEqual(overState.searchKeys, [PROJECT.applicationKey]);
	assert.deepEqual(overState.tools, []);
	assertNoSecrets([explicit.activity, project.activity, overState.activity]);

	const after = await stat(projectPath);
	assert.equal(await readFile(projectPath, "utf8"), beforeContent);
	assert.equal(after.mtimeMs, before.mtimeMs);
	assert.equal(after.mode & 0o777, 0o600);
}));

test("Cohesivity provisions search once and retries once when the endpoint says it is not provisioned", () => withSandbox(async (box) => {
	await writeFile(join(box.workspace, ".cohesivity"), projectFile());
	const output = runChild(childScript(`
		const notProvisioned = () => h.edgeError(403, 'Service not provisioned: You must provision "exa-api" via POST /api/resources/exa-api before using the edge');
		h.edge = (_key, count) => count === 1 ? notProvisioned() : new Response(JSON.stringify({ results: [] }));
		const recovered = await searchWithCohesivity("first");
		const firstTools = h.tools();
		const firstKeys = h.searchKeys();
		h.edge = notProvisioned;
		const failure = await errorOf(searchWithCohesivity("second"));
		done({ recovered: recovered.results, firstTools, firstKeys, failure });
	`), box.env, box.project);
	assert.deepEqual(output.recovered, []);
	assert.deepEqual(output.firstTools, ["provision_resource"]);
	assert.deepEqual(output.mcp[0].args, { tenant_id: PROJECT.tenantId, resource: "exa-api", confirmed: true, coh_management_key: PROJECT.managementKey });
	assert.deepEqual(output.firstKeys, [PROJECT.applicationKey, PROJECT.applicationKey]);
	// Second search: one provision, one retry, then a plain error.
	assert.deepEqual(output.tools, ["provision_resource", "provision_resource"]);
	assert.equal(output.searchKeys.length, 4);
	assert.match(output.failure.text, /^Error: Cohesivity search error 403: Service not provisioned.*\(search could not be enabled for this Cohesivity project\)$/);
	assert.equal(await exists(box.statePath), false);
	assertNoSecrets([output.failure, output.activity]);
}));

test("Cohesivity replaces an expired or rejected anonymous tenant once, and keeps one the user claimed", () => withSandbox(async (box) => {
	await writeState(box, AUTO(9), inHours(-1));
	const expired = runChild(childScript(`
		h.handlers.tenant_status = () => h.toolError(JSON.stringify({ error: "Tenant expired: This temporary tenant expired and has been terminated." }));
		const response = await searchWithCohesivity("q");
		done({ results: response.results.length });
	`), box.env, box.project);
	assert.deepEqual(expired.tools, ["tenant_status", "create_tenant", "provision_resource"]);
	assert.deepEqual(expired.mcp[0].args, { tenant_id: "tenant-9", coh_management_key: AUTO(9).managementKey });
	assert.deepEqual(expired.searchKeys, [AUTO(1).applicationKey]);
	assert.equal(JSON.parse(await readFile(box.statePath, "utf8")).tenant_id, "tenant-1");

	// The endpoint rejects every key: one replacement, one retry, then the error.
	const rejected = runChild(childScript(`
		h.created = 1;
		h.edge = () => h.edgeError(401, "Invalid application key: No tenant found with this key");
		const failure = await errorOf(searchWithCohesivity("q"));
		done({ failure });
	`), box.env, box.project);
	assert.deepEqual(rejected.tools, ["create_tenant", "provision_resource"]);
	assert.deepEqual(rejected.searchKeys, [AUTO(1).applicationKey, AUTO(2).applicationKey]);
	assert.match(rejected.failure.text, /^Error: Cohesivity search error 401: Invalid application key: No tenant found with this key \(the anonymous Cohesivity project saved in .*cohesivity-tenant\.json was rejected\)$/);
	assert.equal(JSON.parse(await readFile(box.statePath, "utf8")).tenant_id, "tenant-2");
	assertNoSecrets([rejected.failure, rejected.activity, expired.activity]);

	// Locally expired, but claimed since: kept, and its expiry cleared.
	await writeState(box, AUTO(9), inHours(-1));
	const claimed = runChild(childScript(`
		h.handlers.tenant_status = () => ({ structuredContent: { status: { account: { status: "active", lifecycle: "claimed", expires_at: null } } } });
		await searchWithCohesivity("q");
		done({});
	`), box.env, box.project);
	assert.deepEqual(claimed.tools, ["tenant_status"]);
	assert.deepEqual(claimed.searchKeys, [AUTO(9).applicationKey]);
	const kept = JSON.parse(await readFile(box.statePath, "utf8"));
	assert.equal(kept.tenant_id, "tenant-9");
	assert.equal(kept.expires_at, null);
}));

test("Cohesivity never replaces an explicit key or a project .cohesivity tenant", () => withSandbox(async (box) => {
	const explicit = runChild(childScript(`
		h.edge = () => h.edgeError(401, "Invalid application key: No tenant found with this key");
		const failure = await errorOf(searchWithCohesivity("q"));
		done({ failure });
	`), { ...box.env, COHESIVITY_APPLICATION_KEY: KEY }, box.project);
	assert.deepEqual(explicit.tools, []);
	assert.deepEqual(explicit.searchKeys, [KEY]);
	assert.match(explicit.failure.text, /error 401: .*cohesivityApplicationKey or COHESIVITY_APPLICATION_KEY/);

	const projectPath = join(box.workspace, ".cohesivity");
	await writeFile(projectPath, projectFile());
	const project = runChild(childScript(`
		h.edge = () => h.edgeError(410, "Tenant expired: This temporary tenant expired and has been terminated.", { tenant_state: "expired" });
		const failure = await errorOf(searchWithCohesivity("q"));
		done({ failure });
	`), box.env, box.project);
	assert.deepEqual(project.tools, []);
	assert.deepEqual(project.searchKeys, [PROJECT.applicationKey]);
	assert.ok(project.failure.text.includes(`error 410: Tenant expired`));
	assert.ok(project.failure.text.includes(projectPath));
	assert.equal(await exists(box.statePath), false);
	assertNoSecrets([explicit.failure, explicit.activity, project.failure, project.activity]);
}));

test("Cohesivity asks for a claim link instead of creating a tenant when the allowance is used up", () => withSandbox(async (box) => {
	await writeState(box, AUTO(1), inHours(10));
	const output = runChild(childScript(`
		const perMinute = () => h.edgeError(429, "Rate limit exceeded for exa-api: requests is 6 in utc_minute, above the ephemeral rate limit of 5. Wait for the next minute and retry.", { tenant_state: "active", window_kind: "utc_minute" });
		const usage = (used) => () => ({ structuredContent: { status: { account: { status: "active", lifecycle: "ephemeral" }, bucket_usage: { "exa-api": { requests_used_all_time: used, requests_limit_all_time: 50, requests_per_minute_limit: 5 } } } } });
		const steps = {};
		h.edge = () => h.edgeError(403, "Tenant paused: Claim this tenant to resume service.", { tenant_state: "paused", pause_reason: { kind: "all_time_cap" } });
		steps.paused = await errorOf(searchWithCohesivity("paused"));
		steps.pausedTools = h.tools();
		h.edge = perMinute;
		h.handlers.tenant_status = usage(3);
		steps.rateLimited = await errorOf(searchWithCohesivity("busy"));
		steps.rateLimitedTools = h.tools().slice(steps.pausedTools.length);
		h.handlers.tenant_status = usage(50);
		steps.exhausted = await errorOf(searchWithCohesivity("spent"));
		steps.exhaustedTools = h.tools().slice(steps.pausedTools.length + steps.rateLimitedTools.length);
		done({ steps });
	`), box.env, box.project);
	const { steps } = output;
	assert.deepEqual(steps.pausedTools, ["claim_tenant"]);
	assert.deepEqual(output.mcp[0].args, { tenant_id: "tenant-1", confirmed: true, coh_management_key: AUTO(1).managementKey });
	assert.equal(steps.paused.text, `Error: Cohesivity search: the free anonymous allowance is used up. Ask the user to open ${APPROVAL_URL} to keep Cohesivity search (one click, free).`);
	assert.deepEqual(steps.rateLimitedTools, ["tenant_status"]);
	assert.match(steps.rateLimited.text, /^Error: Cohesivity search error 429: Rate limit exceeded .*\(rate limited; anonymous projects allow 5 search requests per minute/);
	assert.deepEqual(steps.exhaustedTools, ["tenant_status", "claim_tenant"]);
	assert.ok(steps.exhausted.text.includes(APPROVAL_URL));
	assert.equal(output.tools.includes("create_tenant"), false);
	assert.deepEqual(output.searchKeys, Array(3).fill(AUTO(1).applicationKey));
	assert.equal(JSON.parse(await readFile(box.statePath, "utf8")).tenant_id, "tenant-1");
	assertNoSecrets([steps.rateLimited, output.activity]);
	assertNoSecrets([steps.paused, steps.exhausted], [APPROVAL_TOKEN]);
	assert.ok(output.activity.some(entry => /allowance is used up/.test(entry.error ?? "")));
}));

test("Cohesivity never retries an ambiguous create_tenant failure", () => withSandbox(async (box) => {
	const output = runChild(childScript(`
		const failures = [];
		h.handlers.create_tenant = () => { h.created++; throw new TypeError("fetch failed: socket hang up"); };
		failures.push(await errorOf(searchWithCohesivity("network")));
		const afterNetwork = h.tools().length;
		h.handlers.create_tenant = () => { h.created++; return new Response("bad gateway", { status: 502 }); };
		failures.push(await errorOf(searchWithCohesivity("gateway")));
		done({ failures, afterNetwork });
	`), box.env, box.project);
	assert.equal(output.afterNetwork, 1);
	assert.deepEqual(output.tools, ["create_tenant", "create_tenant"]);
	assert.deepEqual(output.searchKeys, []);
	for (const failure of output.failures) {
		assert.match(failure.text, /creating an anonymous Cohesivity project did not complete .*It was not retried/);
	}
	assert.match(output.failures[1].text, /create_tenant error 502/);
	assert.equal(await exists(box.statePath), false);
}));

test("Cohesivity reports MCP tool errors and JSON-RPC errors without their secrets", () => withSandbox(async (box) => {
	const output = runChild(childScript(`
		h.sse.add("provision_resource");
		h.handlers.provision_resource = (args) => h.toolError(JSON.stringify({ error: "provision_failed", message: "could not provision for " + args.coh_management_key + " (" + "${APPROVAL_URL}" + ")" }));
		const toolFailure = await errorOf(searchWithCohesivity("first"));
		h.sse.delete("provision_resource");
		h.edge = () => h.edgeError(403, "Service not provisioned: You must provision exa-api");
		h.handlers.provision_resource = (args) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid params for " + args.coh_management_key } }));
		const rpcFailure = await errorOf(searchWithCohesivity("second"));
		done({ toolFailure, rpcFailure });
	`), box.env, box.project);
	assert.deepEqual(output.tools, ["create_tenant", "provision_resource", "provision_resource"]);
	assert.equal(output.toolFailure.text, "Error: Cohesivity provision_resource failed: could not provision for [redacted] (https://cohesivity.ai/c/[redacted])");
	assert.equal(output.rpcFailure.text, "Error: Cohesivity provision_resource error -32602: Invalid params for [redacted]");
	// The tenant is kept even though provisioning failed, so the next search reuses it.
	assert.deepEqual(output.searchKeys, [AUTO(1).applicationKey]);
	assert.equal(JSON.parse(await readFile(box.statePath, "utf8")).tenant_id, "tenant-1");
	assertNoSecrets([output.toolFailure, output.rpcFailure, output.activity]);
}));

test("Cohesivity with nothing configured works when selected but is never used by auto or all", () => withSandbox(async (box) => {
	const output = runChild(`
		const h = (${installHarness.toString()})();
		const harnessFetch = globalThis.fetch;
		globalThis.fetch = async (url, init) => String(url).startsWith("https://cohesivity.ai/") ? harnessFetch(url, init) : new Response("unavailable", { status: 503 });
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const outcomes = [];
		for (const provider of ["auto", "all"]) {
			try { outcomes.push((await search(provider, { provider })).provider ?? "aggregate"); } catch { outcomes.push("failed"); }
		}
		const before = h.calls.length;
		const explicit = await search("explicit", { provider: "cohesivity" });
		console.log(JSON.stringify({ outcomes, before, provider: explicit.provider, tools: h.tools() }));
	`, box.env, box.project);
	assert.deepEqual(output.outcomes, ["failed", "failed"]);
	assert.equal(output.before, 0);
	assert.equal(output.provider, "cohesivity");
	assert.deepEqual(output.tools, ["create_tenant", "provision_resource"]);
}));
