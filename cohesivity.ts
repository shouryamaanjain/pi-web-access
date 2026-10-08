import { existsSync, readFileSync } from "node:fs";
import { activityMonitor } from "./activity.ts";
import { normalizeDomain } from "./domain-filter-normalization.ts";
import type { SearchOptions, SearchResponse } from "./perplexity.ts";
import { formatSearchResultsAsAnswer } from "./search-answer-formatting.ts";
import { normalizeSearchResultCount } from "./search-result-count-normalization.ts";
import { resolveCredential } from "./credential-source.ts";
import {
	CohesivityMcpError,
	type CohesivityTenant,
	findProjectCohesivityFile,
	getCohesivityStatePath,
	getTenantAllowance,
	isAllowanceUsedUp,
	obtainAutoTenant,
	provisionSearch,
	redactCohesivitySecrets,
	requestClaimUrl,
} from "./cohesivity-tenant.ts";
import { getWebSearchConfigPath } from "./utils.ts";

// The path segment is fixed by the service.
export const COHESIVITY_SEARCH_URL = "https://cohesivity.ai/edge/exa-api/search";
const CLIENT_USER_AGENT = "pi-web-access";
const CONFIG_PATH = getWebSearchConfigPath();
const SEARCH_TIMEOUT_MS = 30_000;
const HIGHLIGHT_SENTENCES = 2;
const MAX_SNIPPET_CHARS = 500;
const RECENCY_DAYS: Record<NonNullable<SearchOptions["recencyFilter"]>, number> = {
	day: 1,
	week: 7,
	month: 30,
	year: 365,
};

interface WebSearchConfig {
	cohesivityApplicationKey?: unknown;
}

interface CohesivityResult {
	title?: unknown;
	url?: unknown;
	highlights?: unknown;
	summary?: unknown;
	text?: unknown;
}

let cachedConfig: WebSearchConfig | null = null;

function loadConfig(): WebSearchConfig {
	if (cachedConfig) return cachedConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedConfig = {};
		return cachedConfig;
	}
	const raw = readFileSync(CONFIG_PATH, "utf-8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Invalid config in ${CONFIG_PATH}: expected a JSON object`);
	}
	cachedConfig = parsed as WebSearchConfig;
	return cachedConfig;
}

// Where the application key came from decides what recovery is allowed: only the anonymous
// tenant pi-web-access owns is ever replaced, and only tenants whose management key we hold
// can be provisioned or claimed.
type CohesivitySource =
	| { kind: "explicit"; applicationKey: string }
	| { kind: "project"; applicationKey: string; tenantId: string | null; managementKey: string | null; path: string }
	| { kind: "auto"; applicationKey: string; tenantId: string; managementKey: string; created: boolean };

function explicitApplicationKey(signal?: AbortSignal): Promise<string | null> {
	return resolveCredential({
		provider: "Cohesivity",
		configuredValue: loadConfig().cohesivityApplicationKey,
		environmentValue: process.env.COHESIVITY_APPLICATION_KEY,
		signal,
	});
}

function autoSource(tenant: CohesivityTenant, created: boolean): CohesivitySource {
	return { kind: "auto", applicationKey: tenant.applicationKey, tenantId: tenant.tenantId, managementKey: tenant.managementKey, created };
}

async function resolveImplicitSource(signal: AbortSignal | undefined, secrets: string[]): Promise<CohesivitySource> {
	const project = findProjectCohesivityFile();
	if (project) {
		secrets.push(...[project.applicationKey, project.managementKey].filter((value): value is string => !!value));
		if (!project.applicationKey) throw new Error(`Cohesivity search: ${project.path} has no coh_application_key`);
		return { kind: "project", applicationKey: project.applicationKey, tenantId: project.tenantId, managementKey: project.managementKey, path: project.path };
	}
	const { tenant, created } = await obtainAutoTenant(signal);
	secrets.push(tenant.applicationKey, tenant.managementKey);
	return autoSource(tenant, created);
}

interface DomainFilters {
	include: string[];
	exclude: string[];
}

function parseDomainFilter(domainFilter: string[] | undefined): DomainFilters {
	const filters: DomainFilters = { include: [], exclude: [] };
	for (const raw of domainFilter ?? []) {
		const domain = normalizeDomain(raw);
		if (!domain) continue;
		const target = raw.trim().startsWith("-") ? filters.exclude : filters.include;
		if (!target.includes(domain)) target.push(domain);
	}
	return filters;
}

function passesDomainFilters(url: URL, filters: DomainFilters): boolean {
	if (filters.include.length === 0 && filters.exclude.length === 0) return true;
	const hostname = url.hostname.toLowerCase();
	const matches = (domain: string) => hostname === domain || hostname.endsWith(`.${domain}`);
	if (filters.exclude.some(matches)) return false;
	return filters.include.length === 0 || filters.include.some(matches);
}

function startPublishedDate(recency: NonNullable<SearchOptions["recencyFilter"]>): string {
	return new Date(Date.now() - RECENCY_DAYS[recency] * 86_400_000).toISOString();
}

function text(value: unknown): string {
	return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function highlightText(value: unknown): string {
	if (!Array.isArray(value)) return "";
	return text(value.filter((item): item is string => typeof item === "string").join(" "));
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function invalidResponse(message: string): Error {
	return new Error(`Cohesivity search returned invalid response: ${message}`);
}

function parseResponse(value: unknown): CohesivityResult[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse("expected an object envelope");
	const envelope = value as Record<string, unknown>;
	if (!Array.isArray(envelope.results)) throw invalidResponse("expected results array");
	return envelope.results as CohesivityResult[];
}

interface EdgeErrorDetails {
	message: string;
	tenantState: string | null;
	windowKind: string | null;
}

// Errors are `{ error: { code, message: "[Cohesivity] ..." }, tenant_state?, window_kind? }`;
// keep the readable message and the fields that tell a pause from a per-minute limit.
function describeError(body: string): EdgeErrorDetails {
	try {
		const parsed = JSON.parse(body) as { error?: { message?: unknown; tenant_state?: unknown }; tenant_state?: unknown; window_kind?: unknown };
		const message = text(parsed?.error?.message).replace(/^\[Cohesivity\]\s*/i, "");
		if (message) {
			return {
				message,
				tenantState: text(parsed.tenant_state ?? parsed.error?.tenant_state) || null,
				windowKind: text(parsed.window_kind) || null,
			};
		}
	} catch {}
	return { message: text(body), tenantState: null, windowKind: null };
}

class CohesivityEdgeError extends Error {
	readonly status: number;
	readonly details: EdgeErrorDetails;

	constructor(status: number, details: EdgeErrorDetails) {
		super(`Cohesivity search error ${status}: ${details.message}`);
		this.status = status;
		this.details = details;
	}
}

/** Carries the claim link; it is the only error allowed to contain it, and never reaches activity logs. */
class CohesivityAllowanceError extends Error {
	readonly activityMessage = "Cohesivity search: the free anonymous allowance is used up (claim link returned to the agent)";
}

function isNotProvisioned(error: CohesivityEdgeError): boolean {
	return error.status === 403 && /not provisioned/i.test(error.details.message);
}

function isPerMinuteLimit(error: CohesivityEdgeError): boolean {
	return error.details.windowKind === "utc_minute" || /rate limit|per[- ]minute|utc_minute/i.test(error.details.message);
}

function mentionsUsedUpAllowance(error: CohesivityEdgeError): boolean {
	if (error.status !== 403 && error.status !== 429) return false;
	if (isNotProvisioned(error) || /not allowed|plan limit/i.test(error.details.message) || isPerMinuteLimit(error)) return false;
	return error.details.tenantState === "paused" || /paus|quota|exhaust|allowance|all[_ ]time|limit/i.test(error.details.message);
}

function errorHint(error: CohesivityEdgeError, source: CohesivitySource): string {
	const { status } = error;
	const message = error.details.message;
	if (status === 401) {
		if (source.kind === "project") return ` (the coh_application_key in ${source.path} was rejected)`;
		if (source.kind === "auto") return ` (the anonymous Cohesivity project saved in ${getCohesivityStatePath()} was rejected)`;
		return " (check that cohesivityApplicationKey or COHESIVITY_APPLICATION_KEY is the coh_application_key from your .cohesivity file)";
	}
	if (status === 410) {
		if (source.kind === "project") return ` (this Cohesivity project expired; run \`npx @cohesivity/init\` for a new one or remove ${source.path})`;
		return " (this Cohesivity project expired)";
	}
	if (isNotProvisioned(error)) {
		if (source.kind === "explicit") return " (search must be provisioned once for this Cohesivity project; ask your coding agent to provision it with the management key in .cohesivity)";
		return " (search could not be enabled for this Cohesivity project)";
	}
	if (status === 429 && isPerMinuteLimit(error)) return " (rate limited; anonymous projects allow 5 search requests per minute and 50 in total until claimed)";
	if (mentionsUsedUpAllowance(error)) return " (this Cohesivity project is paused, usually because its free anonymous allowance is used up; claiming it lifts the limit)";
	if (status === 429) return " (rate limited; anonymous projects allow 5 search requests per minute and 50 in total until claimed)";
	return "";
}

// The key can only travel as the `key` query parameter, and fetchWithCredentialRedirects
// strips credential headers, not URL parameters. The endpoint never redirects, so every
// redirect is refused rather than followed, which keeps the key off any other URL.
async function fetchWithoutRedirects(url: URL, init: RequestInit): Promise<Response> {
	const response = await fetch(url, { ...init, redirect: "manual" });
	if (response.status >= 300 && response.status < 400) {
		await response.body?.cancel().catch(() => {});
		throw new Error(`Cohesivity search error ${response.status}: refused an unexpected redirect`);
	}
	return response;
}

/** One search request. Errors are fresh and redacted; HTTP failures are CohesivityEdgeError. */
async function edgeSearch(key: string, body: Record<string, unknown>, signal: AbortSignal | undefined): Promise<CohesivityResult[]> {
	const url = new URL(COHESIVITY_SEARCH_URL);
	url.searchParams.set("key", key);
	const timeoutSignal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	try {
		const response = await fetchWithoutRedirects(url, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				// The service's firewall may reject the default Node fetch User-Agent.
				"User-Agent": CLIENT_USER_AGENT,
			},
			body: JSON.stringify(body),
			signal: signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal,
		});
		if (!response.ok) {
			const details = describeError(await response.text());
			throw new CohesivityEdgeError(response.status, { ...details, message: redactCohesivitySecrets(details.message, [key]).slice(0, 300) });
		}
		let rawData: unknown;
		try {
			rawData = await response.json();
		} catch (err) {
			if (err instanceof Error && err.name === "TimeoutError") throw err;
			throw new Error(`Cohesivity search returned invalid JSON: ${errorMessage(err)}`);
		}
		return parseResponse(rawData);
	} catch (err) {
		if (signal?.aborted) throw new Error("Aborted");
		if (err instanceof CohesivityEdgeError) throw err;
		const providerTimeout = timeoutSignal.aborted || (err instanceof Error && err.name === "TimeoutError");
		// Always rethrow a fresh error: the original may carry the request URL, and with it
		// the key, in its message or cause chain.
		const outgoing = new Error(providerTimeout
			? `Cohesivity search request timed out after ${Math.round(SEARCH_TIMEOUT_MS / 1000)}s`
			: redactCohesivitySecrets(errorMessage(err), [key]));
		if (!providerTimeout && err instanceof Error) outgoing.name = err.name;
		throw outgoing;
	}
}

async function allowanceUsedUp(error: CohesivityEdgeError, tenant: { tenantId: string; managementKey: string }, signal?: AbortSignal): Promise<boolean> {
	if (mentionsUsedUpAllowance(error)) return true;
	// A 429 can be the per-minute limit or the end of the allowance; the tenant's usage tells them apart.
	if (error.status !== 429) return false;
	try {
		return isAllowanceUsedUp(await getTenantAllowance(tenant, signal));
	} catch (err) {
		if (signal?.aborted) throw err;
		return false;
	}
}

async function allowanceError(tenant: { tenantId: string; managementKey: string }, signal?: AbortSignal): Promise<Error> {
	let approvalUrl: string;
	try {
		approvalUrl = await requestClaimUrl(tenant, signal);
	} catch (err) {
		if (signal?.aborted) throw err;
		return new Error(`Cohesivity search: the free anonymous allowance is used up, and no claim link could be requested (${errorMessage(err)})`);
	}
	return new CohesivityAllowanceError(`Cohesivity search: the free anonymous allowance is used up. Ask the user to open ${approvalUrl} to keep Cohesivity search (one click, free).`);
}

// Searches, then recovers at most once from each of: search not provisioned (provision and
// retry), a rejected or expired anonymous tenant (replace it and retry), and a used-up
// allowance (request a claim link instead of creating another tenant).
async function searchWithRecovery(body: Record<string, unknown>, signal: AbortSignal | undefined, explicitKey: string | null, secrets: string[]): Promise<CohesivityResult[]> {
	let source: CohesivitySource = explicitKey
		? { kind: "explicit", applicationKey: explicitKey }
		: await resolveImplicitSource(signal, secrets);
	let provisioned = false;
	let replaced = source.kind === "auto" && source.created;
	for (;;) {
		try {
			return await edgeSearch(source.applicationKey, body, signal);
		} catch (err) {
			if (!(err instanceof CohesivityEdgeError)) throw err;
			const tenant = source.kind !== "explicit" && source.tenantId && source.managementKey
				? { tenantId: source.tenantId, managementKey: source.managementKey, applicationKey: source.applicationKey }
				: null;
			if (isNotProvisioned(err) && tenant && !provisioned) {
				provisioned = true;
				await provisionSearch(tenant, signal);
				continue;
			}
			if (source.kind === "auto" && (err.status === 401 || err.status === 410) && !replaced) {
				replaced = true;
				const next = await obtainAutoTenant(signal, source.tenantId);
				secrets.push(next.tenant.applicationKey, next.tenant.managementKey);
				source = autoSource(next.tenant, true);
				continue;
			}
			if (tenant && await allowanceUsedUp(err, tenant, signal)) throw await allowanceError(tenant, signal);
			throw new Error(`${err.message}${errorHint(err, source)}`);
		}
	}
}

export function isCohesivityAvailable(): boolean {
	// With no key configured, a project .cohesivity file or an anonymous tenant created on first use supplies one.
	return true;
}

export async function searchWithCohesivity(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const explicitKey = await explicitApplicationKey(options.signal);
	const numResults = normalizeSearchResultCount(options.numResults);
	const filters = parseDomainFilter(options.domainFilter);
	const body = {
		query,
		numResults,
		type: "auto",
		contents: { highlights: { numSentences: HIGHLIGHT_SENTENCES } },
		...(filters.include.length > 0 ? { includeDomains: filters.include } : {}),
		...(filters.exclude.length > 0 ? { excludeDomains: filters.exclude } : {}),
		...(options.recencyFilter ? { startPublishedDate: startPublishedDate(options.recencyFilter) } : {}),
	};
	const secrets: string[] = explicitKey ? [explicitKey] : [];
	const activityId = activityMonitor.logStart({ type: "api", query });
	let entries: CohesivityResult[];
	try {
		entries = await searchWithRecovery(body, options.signal, explicitKey, secrets);
	} catch (err) {
		if (options.signal?.aborted) {
			activityMonitor.logComplete(activityId, 0);
			throw new Error("Aborted");
		}
		if (err instanceof CohesivityAllowanceError) {
			activityMonitor.logError(activityId, err.activityMessage);
			throw err;
		}
		const outgoing = new Error(redactCohesivitySecrets(errorMessage(err), secrets));
		if (err instanceof Error && err.name !== "Error" && !(err instanceof CohesivityMcpError)) outgoing.name = err.name;
		activityMonitor.logError(activityId, outgoing.message);
		throw outgoing;
	}
	activityMonitor.logComplete(activityId, 200);
	const results: SearchResponse["results"] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		if (typeof entry.url !== "string" || !entry.url) continue;
		let resultUrl: URL;
		try {
			resultUrl = new URL(entry.url);
		} catch {
			continue;
		}
		if (resultUrl.protocol !== "http:" && resultUrl.protocol !== "https:") continue;
		// Domains are filtered natively; this is a backstop.
		if (!passesDomainFilters(resultUrl, filters)) continue;
		if (seen.has(resultUrl.href)) continue;
		seen.add(resultUrl.href);
		const snippet = highlightText(entry.highlights) || text(entry.summary) || text(entry.text);
		results.push({
			title: text(entry.title) || `Source ${results.length + 1}`,
			url: resultUrl.href,
			snippet: snippet.slice(0, MAX_SNIPPET_CHARS),
		});
		if (results.length >= numResults) break;
	}
	return { answer: formatSearchResultsAsAnswer(results), results };
}
