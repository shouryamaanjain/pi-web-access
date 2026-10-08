import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { awaitWithAbort } from "./abortable.ts";
import { redactCredential } from "./credential-source.ts";
import { getWebSearchConfigDir } from "./utils.ts";

// Cohesivity credentials for search: a project `.cohesivity` file, or an anonymous tenant that
// pi-web-access creates through Cohesivity's hosted MCP server and keeps in a private state file.
// Every MCP response can carry keys, so bodies are never logged and every error is redacted.

export const COHESIVITY_MCP_URL = "https://cohesivity.ai/mcp";
const CLIENT_USER_AGENT = "pi-web-access";
const MCP_TIMEOUT_MS = 30_000;
const PROJECT_FILE_NAME = ".cohesivity";
const STATE_FILE_NAME = "cohesivity-tenant.json";
const SEARCH_RESOURCE = "exa-api";
const O_NOFOLLOW = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
// Key shapes (coh_man_..., coh_app_...) and claim tokens are scrubbed even when the exact
// value is not known to the caller.
const KEY_PATTERN = /\bcoh_(?:man|app|mgmt)_[A-Za-z0-9_-]{8,}/g;
const CLAIM_TOKEN_PATTERN = /(\/c\/)[A-Za-z0-9._~-]+/g;
const DEAD_TENANT_PATTERN = /no tenant found|tenant expired|has been terminated|invalid management key/i;

export interface CohesivityTenant {
	tenantId: string;
	managementKey: string;
	applicationKey: string;
	expiresAt: string | null;
}

export interface ProjectCohesivityFile {
	path: string;
	tenantId: string | null;
	managementKey: string | null;
	applicationKey: string | null;
	expiresAt: string | null;
}

export interface TenantAllowance {
	paused: boolean;
	lifecycle: string | null;
	expiresAt: string | null;
	used: number | null;
	limit: number | null;
}

export class CohesivityMcpError extends Error {
	/** The request may have reached the server, so its outcome is unknown. */
	readonly ambiguous: boolean;
	/** The server answered with a tool-level failure (`isError` or JSON-RPC `error`). */
	readonly toolError: boolean;

	constructor(message: string, options: { ambiguous?: boolean; toolError?: boolean } = {}) {
		super(message);
		this.name = "CohesivityMcpError";
		this.ambiguous = options.ambiguous ?? false;
		this.toolError = options.toolError ?? false;
	}
}

export function redactCohesivitySecrets(text: string, secrets: readonly (string | null | undefined)[] = []): string {
	let out = text;
	for (const secret of secrets) out = redactCredential(out, secret);
	return out.replace(KEY_PATTERN, "[redacted]").replace(CLAIM_TOKEN_PATTERN, "$1[redacted]");
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function clean(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed ? trimmed : null;
}

/** Parses `.cohesivity` content: `key=value` lines, `#` comments. */
export function parseCohesivityFile(content: string): Record<string, string> {
	const values: Record<string, string> = {};
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const separator = line.indexOf("=");
		if (separator <= 0) continue;
		let value = line.slice(separator + 1).trim();
		if (value.length >= 2 && (value[0] === "\"" || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
		values[line.slice(0, separator).trim()] = value;
	}
	return values;
}

/** Finds `.cohesivity` in the working directory or a parent, stopping at the home directory or the root. Read-only. */
export function findProjectCohesivityFile(startDir: string = process.cwd()): ProjectCohesivityFile | null {
	const home = resolve(homedir());
	let dir = resolve(startDir);
	for (;;) {
		const candidate = join(dir, PROJECT_FILE_NAME);
		let isFile = false;
		try {
			isFile = statSync(candidate).isFile();
		} catch {}
		if (isFile) {
			const values = parseCohesivityFile(readFileSync(candidate, "utf8"));
			return {
				path: candidate,
				tenantId: clean(values.tenant_id),
				managementKey: clean(values.coh_management_key),
				applicationKey: clean(values.coh_application_key),
				expiresAt: clean(values.expires_at),
			};
		}
		const parent = dirname(dir);
		if (dir === home || parent === dir) return null;
		dir = parent;
	}
}

export function getCohesivityStatePath(): string {
	return join(getWebSearchConfigDir(), STATE_FILE_NAME);
}

function enforceMode(apply: () => void): void {
	try {
		apply();
	} catch (err) {
		if (process.platform !== "win32") throw err;
	}
}

/** The anonymous tenant pi-web-access created, or null when none is saved or the file is unusable. */
export function readAutoTenant(): CohesivityTenant | null {
	const path = getCohesivityStatePath();
	try {
		const info = lstatSync(path);
		if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Cohesivity tenant state ${path} is not a regular file`);
		if (process.platform !== "win32" && (info.mode & 0o077) !== 0) enforceMode(() => chmodSync(path, 0o600));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const data = parsed as Record<string, unknown>;
	const tenantId = clean(data.tenant_id);
	const managementKey = clean(data.coh_management_key);
	const applicationKey = clean(data.coh_application_key);
	if (!tenantId || !managementKey || !applicationKey) return null;
	return { tenantId, managementKey, applicationKey, expiresAt: clean(data.expires_at) };
}

/** Atomically replaces the state file (temp file + rename), readable only by the user. */
export function writeAutoTenant(tenant: CohesivityTenant): void {
	const path = getCohesivityStatePath();
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const serialized = JSON.stringify({
		tenant_id: tenant.tenantId,
		coh_management_key: tenant.managementKey,
		coh_application_key: tenant.applicationKey,
		expires_at: tenant.expiresAt,
	}, null, 2) + "\n";
	const tmpPath = join(dir, `.${STATE_FILE_NAME}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
	let fd: number | null = null;
	try {
		fd = openSync(tmpPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | O_NOFOLLOW, 0o600);
		const opened = fd;
		enforceMode(() => fchmodSync(opened, 0o600));
		writeFileSync(fd, serialized, "utf8");
		fsyncSync(fd);
		closeSync(fd);
		fd = null;
		renameSync(tmpPath, path);
	} catch (err) {
		if (fd !== null) try { closeSync(fd); } catch {}
		try { unlinkSync(tmpPath); } catch {}
		throw new Error(`Failed to save Cohesivity tenant state to ${path}: ${redactCohesivitySecrets(errorMessage(err), [tenant.managementKey, tenant.applicationKey])}`);
	}
}

/** Removes the state file if it still holds this tenant, so a newer tenant saved by another process survives. */
export function discardAutoTenant(tenantId: string): void {
	try {
		if (readAutoTenant()?.tenantId === tenantId) unlinkSync(getCohesivityStatePath());
	} catch {}
}

export function isLocallyExpired(expiresAt: string | null, now = Date.now()): boolean {
	if (!expiresAt) return false;
	const time = Date.parse(expiresAt);
	return Number.isFinite(time) && time <= now;
}

interface McpResponse {
	result?: { content?: Array<{ type?: string; text?: string }>; structuredContent?: unknown; isError?: boolean };
	error?: { code?: number; message?: string };
}

// Tool failures carry a JSON document such as { error, message } in their text content.
function describeToolText(text: string): string {
	try {
		const parsed = JSON.parse(text) as Record<string, unknown>;
		const nested = parsed.error && typeof parsed.error === "object" ? (parsed.error as Record<string, unknown>).message : undefined;
		const message = clean(parsed.message) ?? clean(nested) ?? clean(parsed.error);
		if (message) return message.replace(/^\[Cohesivity\]\s*/i, "");
	} catch {}
	return text.replace(/\s+/g, " ").trim();
}

/** One JSON-RPC `tools/call` against the hosted MCP server; no session or Authorization is needed. */
export async function callCohesivityMcp(
	tool: string,
	args: Record<string, unknown>,
	options: { signal?: AbortSignal; secrets?: readonly (string | null | undefined)[] } = {},
): Promise<Record<string, unknown>> {
	const secrets = options.secrets ?? [];
	const redact = (text: string) => redactCohesivitySecrets(text, secrets);
	const timeout = AbortSignal.timeout(MCP_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	let body: string;
	let response: Response;
	try {
		response = await fetch(COHESIVITY_MCP_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Accept": "application/json, text/event-stream",
				// The service's firewall may reject the default Node fetch User-Agent.
				"User-Agent": CLIENT_USER_AGENT,
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
			// The request body carries the management key, so it must never be replayed elsewhere.
			redirect: "manual",
			signal,
		});
		body = await response.text();
	} catch (err) {
		if (options.signal?.aborted) throw new Error("Aborted");
		if (timeout.aborted || (err instanceof Error && err.name === "TimeoutError")) {
			throw new CohesivityMcpError(`Cohesivity ${tool} timed out after ${Math.round(MCP_TIMEOUT_MS / 1000)}s`, { ambiguous: true });
		}
		throw new CohesivityMcpError(`Cohesivity ${tool} request failed: ${redact(errorMessage(err))}`, { ambiguous: true });
	}
	if (response.status >= 300 && response.status < 400) {
		throw new CohesivityMcpError(`Cohesivity ${tool} error ${response.status}: refused an unexpected redirect`);
	}

	let parsed: McpResponse | null = null;
	for (const candidate of [...body.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()), body]) {
		if (!candidate) continue;
		try {
			const value = JSON.parse(candidate) as McpResponse;
			if (value && (value.result || value.error)) {
				parsed = value;
				break;
			}
		} catch {}
	}
	if (!response.ok) {
		const detail = parsed?.error?.message ? describeToolText(parsed.error.message) : describeToolText(body);
		const suffix = detail ? `: ${redact(detail).slice(0, 200)}` : "";
		// A gateway failure may arrive after the server acted on the request.
		throw new CohesivityMcpError(`Cohesivity ${tool} error ${response.status}${suffix}`, { ambiguous: response.status >= 500 });
	}
	if (!parsed) throw new CohesivityMcpError(`Cohesivity ${tool} returned invalid JSON-RPC content`, { ambiguous: true });
	if (parsed.error) {
		const code = typeof parsed.error.code === "number" ? ` ${parsed.error.code}` : "";
		throw new CohesivityMcpError(`Cohesivity ${tool} error${code}: ${redact(describeToolText(parsed.error.message || "Unknown error")).slice(0, 300)}`, { toolError: true });
	}
	if (parsed.result?.isError) {
		const text = parsed.result.content?.find(item => item.type === "text" && typeof item.text === "string")?.text ?? "";
		throw new CohesivityMcpError(`Cohesivity ${tool} failed: ${redact(describeToolText(text) || "unknown error").slice(0, 300)}`, { toolError: true });
	}
	const structured = parsed.result?.structuredContent;
	if (structured && typeof structured === "object" && !Array.isArray(structured)) return structured as Record<string, unknown>;
	const text = parsed.result?.content?.find(item => item.type === "text" && typeof item.text === "string" && item.text.trim())?.text;
	if (text) {
		try {
			const value = JSON.parse(text) as unknown;
			if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
		} catch {}
	}
	throw new CohesivityMcpError(`Cohesivity ${tool} returned no structured content`);
}

function tenantSecrets(tenant: { managementKey?: string | null; applicationKey?: string | null }): string[] {
	return [tenant.managementKey, tenant.applicationKey].filter((value): value is string => !!value);
}

/** Creates a 72-hour anonymous tenant. Never retried: a lost reply could still have created one. */
export async function createAnonymousTenant(signal?: AbortSignal): Promise<CohesivityTenant> {
	let created: Record<string, unknown>;
	try {
		created = await callCohesivityMcp("create_tenant", { confirmed: true }, { signal });
	} catch (err) {
		if (err instanceof CohesivityMcpError && err.ambiguous) {
			throw new Error(`Cohesivity search: creating an anonymous Cohesivity project did not complete (${err.message}). It was not retried, so no duplicate is created; run the search again.`);
		}
		if (err instanceof CohesivityMcpError && (/ 429\b/.test(err.message) || /rate.?limit/i.test(err.message))) {
			throw new Error("Cohesivity search: Cohesivity is limiting how fast new anonymous projects are created (10 per minute per IP). Wait a minute and retry.");
		}
		throw err;
	}
	const file = created.credentials_file && typeof created.credentials_file === "object" ? (created.credentials_file as Record<string, unknown>).content : undefined;
	const values = typeof file === "string" ? parseCohesivityFile(file) : {};
	const tenantId = clean(values.tenant_id) ?? clean(created.tenant_id);
	const managementKey = clean(values.coh_management_key);
	const applicationKey = clean(values.coh_application_key);
	if (!tenantId || !managementKey || !applicationKey) {
		throw new Error("Cohesivity search: create_tenant returned no usable credentials");
	}
	return { tenantId, managementKey, applicationKey, expiresAt: clean(values.expires_at) ?? clean(created.expires_at) };
}

/** Enables search for a tenant. Idempotent on the server. */
export async function provisionSearch(tenant: { tenantId: string; managementKey: string; applicationKey?: string | null }, signal?: AbortSignal): Promise<void> {
	const result = await callCohesivityMcp("provision_resource", {
		tenant_id: tenant.tenantId,
		resource: SEARCH_RESOURCE,
		confirmed: true,
		coh_management_key: tenant.managementKey,
	}, { signal, secrets: tenantSecrets(tenant) });
	const outcome = result.result && typeof result.result === "object" ? result.result as Record<string, unknown> : null;
	if (outcome && outcome.success === false) {
		throw new Error(`Cohesivity search: enabling search failed${clean(outcome.status) ? ` (status ${clean(outcome.status)})` : ""}`);
	}
}

export async function getTenantAllowance(tenant: { tenantId: string; managementKey: string; applicationKey?: string | null }, signal?: AbortSignal): Promise<TenantAllowance> {
	const result = await callCohesivityMcp("tenant_status", {
		tenant_id: tenant.tenantId,
		coh_management_key: tenant.managementKey,
	}, { signal, secrets: tenantSecrets(tenant) });
	const status = result.status && typeof result.status === "object" ? result.status as Record<string, unknown> : {};
	const account = status.account && typeof status.account === "object" ? status.account as Record<string, unknown> : {};
	const buckets = status.bucket_usage && typeof status.bucket_usage === "object" ? status.bucket_usage as Record<string, unknown> : {};
	const bucket = buckets[SEARCH_RESOURCE] && typeof buckets[SEARCH_RESOURCE] === "object" ? buckets[SEARCH_RESOURCE] as Record<string, unknown> : {};
	const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
	return {
		paused: clean(account.status) === "paused",
		lifecycle: clean(account.lifecycle),
		expiresAt: clean(account.expires_at),
		used: number(bucket.requests_used_all_time),
		limit: number(bucket.requests_limit_all_time),
	};
}

export function isAllowanceUsedUp(allowance: TenantAllowance): boolean {
	return allowance.paused || (allowance.used !== null && allowance.limit !== null && allowance.used >= allowance.limit);
}

/** True when tenant_status reports the tenant gone or expired; false when it is alive or the answer is unclear. */
export function isDeadTenantError(err: unknown): boolean {
	return err instanceof CohesivityMcpError && err.toolError && DEAD_TENANT_PATTERN.test(err.message);
}

/** A one-click link the human opens to keep the tenant. Only https://cohesivity.ai links are relayed. */
export async function requestClaimUrl(tenant: { tenantId: string; managementKey: string; applicationKey?: string | null }, signal?: AbortSignal): Promise<string> {
	const result = await callCohesivityMcp("claim_tenant", {
		tenant_id: tenant.tenantId,
		confirmed: true,
		coh_management_key: tenant.managementKey,
	}, { signal, secrets: tenantSecrets(tenant) });
	const raw = clean(result.approval_url);
	let url: URL | null = null;
	try {
		url = raw ? new URL(raw) : null;
	} catch {}
	if (!url || url.protocol !== "https:" || url.hostname !== "cohesivity.ai" || url.username || url.password) {
		throw new Error("Cohesivity claim_tenant returned no usable approval link");
	}
	return url.href;
}

let bootstrapInFlight: Promise<CohesivityTenant> | null = null;

/**
 * Returns the saved anonymous tenant, or creates, saves and provisions one. Concurrent callers in
 * this process share a single creation. `staleTenantId` names a tenant the caller saw rejected, so
 * it is replaced instead of reused. The shared creation ignores any one caller's AbortSignal (an
 * aborted create could leave an unsaved tenant behind); each caller still stops waiting when its
 * own signal aborts.
 */
export async function obtainAutoTenant(signal?: AbortSignal, staleTenantId?: string): Promise<{ tenant: CohesivityTenant; created: boolean }> {
	if (!bootstrapInFlight) {
		const saved = readAutoTenant();
		if (saved && saved.tenantId !== staleTenantId) {
			if (!isLocallyExpired(saved.expiresAt)) return { tenant: saved, created: false };
			const alive = await refreshExpiredTenant(saved, signal);
			if (alive) return { tenant: alive, created: false };
			staleTenantId = saved.tenantId;
		}
	}
	if (!bootstrapInFlight) {
		const stale = staleTenantId;
		const running = (async () => {
			// Re-read right before creating: another process may have saved a tenant meanwhile.
			const current = readAutoTenant();
			if (current && current.tenantId !== stale && !isLocallyExpired(current.expiresAt)) return current;
			if (stale) discardAutoTenant(stale);
			const tenant = await createAnonymousTenant();
			writeAutoTenant(tenant);
			await provisionSearch(tenant);
			return tenant;
		})();
		bootstrapInFlight = running;
		running.then(() => {}, () => {}).finally(() => {
			if (bootstrapInFlight === running) bootstrapInFlight = null;
		});
	}
	const tenant = await awaitWithAbort(bootstrapInFlight, signal);
	return { tenant, created: true };
}

// The saved expiry is from creation time; a tenant the user claimed since then no longer expires.
async function refreshExpiredTenant(saved: CohesivityTenant, signal?: AbortSignal): Promise<CohesivityTenant | null> {
	let allowance: TenantAllowance;
	try {
		allowance = await getTenantAllowance(saved, signal);
	} catch (err) {
		if (signal?.aborted) throw err;
		// Unclear answers keep the tenant; the search endpoint then decides.
		return isDeadTenantError(err) ? null : saved;
	}
	const claimed = allowance.lifecycle === "claimed";
	if (!claimed && isLocallyExpired(allowance.expiresAt)) return null;
	const refreshed = { ...saved, expiresAt: claimed ? null : allowance.expiresAt };
	try {
		writeAutoTenant(refreshed);
	} catch {}
	return refreshed;
}
