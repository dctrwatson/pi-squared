import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import WebSocket, { WebSocketServer, type RawData } from "ws";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 27183;
const PROTOCOL_VERSION = 1;
const HELLO_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const THREAD_REQUEST_TIMEOUT_MS = 20_000;
const CHANNEL_RANGE_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_TOKEN_FILE = join(homedir(), ".config", "slack-pi", "token");

type BridgeLifecycle = "stopped" | "starting" | "listening" | "error";

interface HelloMessage {
	type: "hello";
	role: "chrome";
	version: number;
	token: string;
	payload?: {
		extensionVersion?: string;
	};
}

interface HelloAckMessage {
	type: "hello_ack";
	role: "pi";
	version: number;
	payload: {
		instance: "slack-pi";
		protocolVersion: number;
	};
}

interface EventMessage {
	type: "event";
	event: string;
	payload?: unknown;
}

interface RequestMessage {
	id: string;
	type: "request";
	action: string;
	payload?: Record<string, unknown>;
}

interface ResponseMessage {
	id: string;
	type: "response";
	ok: boolean;
	payload?: unknown;
	error?: {
		code?: string;
		message?: string;
	};
}

interface ActiveChromeConnection {
	socket: WebSocket;
	connectedAt: number;
	authenticatedAt: number;
	lastSeenAt: number;
	extensionVersion?: string;
	remoteAddress?: string;
}

interface PendingRequest {
	action: string;
	startedAt: number;
	timeout: NodeJS.Timeout;
	resolve: (response: ResponseMessage) => void;
	reject: (error: Error) => void;
}

interface BridgeState {
	lifecycle: BridgeLifecycle;
	host: string;
	port: number;
	wsUrl: string;
	tokenFile: string;
	token: string;
	tokenCreated: boolean;
	startupError?: string;
	server?: WebSocketServer;
	activeChrome?: ActiveChromeConnection;
	pendingRequests: Map<string, PendingRequest>;
	lastPingAt?: number;
	lastPongAt?: number;
	lastPingRoundTripMs?: number;
}

interface SlackThreadMessage {
	author?: string;
	text: string;
	timestamp?: string;
	isRoot?: boolean;
}

interface SlackThreadSnapshot {
	workspace?: string;
	channel?: string;
	title?: string;
	url: string;
	isThread: boolean;
	rootMessage?: SlackThreadMessage;
	messages: SlackThreadMessage[];
	composerDraftText?: string;
	reportedMessageCount?: number;
	harvestedViaScroll?: boolean;
}

interface SlackChannelRangeSnapshot {
	workspace?: string;
	channel?: string;
	title?: string;
	url: string;
	startUrl: string;
	endUrl?: string;
	requestedLimit?: number;
	messages: SlackThreadMessage[];
	harvestedViaScroll?: boolean;
}

const state: BridgeState = {
	lifecycle: "stopped",
	host: HOST,
	port: resolvePort(),
	wsUrl: `ws://${HOST}:${resolvePort()}`,
	tokenFile: resolveTokenFile(),
	token: "",
	tokenCreated: false,
	pendingRequests: new Map(),
};

let startupPromise: Promise<void> | undefined;

function resolvePort(): number {
	const raw = process.env.SLACK_PI_PORT;
	if (!raw) return DEFAULT_PORT;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) return DEFAULT_PORT;
	return parsed;
}

function resolveTokenFile(): string {
	const configured = process.env.SLACK_PI_TOKEN_FILE?.trim();
	return configured ? configured : DEFAULT_TOKEN_FILE;
}

function maskToken(token: string): string {
	if (!token) return "(missing)";
	if (token.length <= 8) return "********";
	return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

function formatTimestamp(timestamp?: number): string {
	if (!timestamp) return "never";
	return new Date(timestamp).toLocaleString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isHelloMessage(value: unknown): value is HelloMessage {
	if (!isRecord(value)) return false;
	return (
		value.type === "hello" &&
		value.role === "chrome" &&
		typeof value.version === "number" &&
		typeof value.token === "string"
	);
}

function isResponseMessage(value: unknown): value is ResponseMessage {
	if (!isRecord(value)) return false;
	return value.type === "response" && typeof value.id === "string" && typeof value.ok === "boolean";
}

function isEventMessage(value: unknown): value is EventMessage {
	if (!isRecord(value)) return false;
	return value.type === "event" && typeof value.event === "string";
}

function isSlackThreadMessage(value: unknown): value is SlackThreadMessage {
	if (!isRecord(value)) return false;
	return (
		typeof value.text === "string" &&
		(value.author === undefined || typeof value.author === "string") &&
		(value.timestamp === undefined || typeof value.timestamp === "string") &&
		(value.isRoot === undefined || typeof value.isRoot === "boolean")
	);
}

function isSlackThreadSnapshot(value: unknown): value is SlackThreadSnapshot {
	if (!isRecord(value)) return false;
	return (
		typeof value.url === "string" &&
		typeof value.isThread === "boolean" &&
		(value.workspace === undefined || typeof value.workspace === "string") &&
		(value.channel === undefined || typeof value.channel === "string") &&
		(value.title === undefined || typeof value.title === "string") &&
		(value.composerDraftText === undefined || typeof value.composerDraftText === "string") &&
		(value.reportedMessageCount === undefined || typeof value.reportedMessageCount === "number") &&
		(value.harvestedViaScroll === undefined || typeof value.harvestedViaScroll === "boolean") &&
		Array.isArray(value.messages) &&
		value.messages.every(isSlackThreadMessage) &&
		(value.rootMessage === undefined || isSlackThreadMessage(value.rootMessage))
	);
}

function isSlackChannelRangeSnapshot(value: unknown): value is SlackChannelRangeSnapshot {
	if (!isRecord(value)) return false;
	return (
		typeof value.url === "string" &&
		typeof value.startUrl === "string" &&
		(value.endUrl === undefined || typeof value.endUrl === "string") &&
		(value.requestedLimit === undefined || typeof value.requestedLimit === "number") &&
		(value.workspace === undefined || typeof value.workspace === "string") &&
		(value.channel === undefined || typeof value.channel === "string") &&
		(value.title === undefined || typeof value.title === "string") &&
		(value.harvestedViaScroll === undefined || typeof value.harvestedViaScroll === "boolean") &&
		Array.isArray(value.messages) &&
		value.messages.every(isSlackThreadMessage)
	);
}

function rawDataToString(data: RawData): string {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
	if (Array.isArray(data)) {
		return Buffer.concat(
			data.map((chunk) => (chunk instanceof ArrayBuffer ? Buffer.from(chunk) : Buffer.from(chunk))),
		).toString("utf8");
	}
	return Buffer.from(data).toString("utf8");
}

function connectionSummary(): string {
	if (!state.activeChrome) return "disconnected";
	const version = state.activeChrome.extensionVersion ? ` (ext ${state.activeChrome.extensionVersion})` : "";
	return `connected${version}`;
}

function formatStatus(showToken: boolean): string {
	const lines = [
		`Slack Pi bridge: ${state.lifecycle}`,
		`Endpoint: ${state.wsUrl}`,
		`Token file: ${state.tokenFile}`,
		`Token: ${showToken ? state.token : maskToken(state.token)}`,
		`Chrome: ${connectionSummary()}`,
		`Mode: read-only Slack assistant`,
	];

	if (state.activeChrome) {
		lines.push(`Chrome connected at: ${formatTimestamp(state.activeChrome.connectedAt)}`);
		lines.push(`Chrome last seen: ${formatTimestamp(state.activeChrome.lastSeenAt)}`);
		if (state.activeChrome.remoteAddress) {
			lines.push(`Chrome remote address: ${state.activeChrome.remoteAddress}`);
		}
	}

	if (state.lastPingAt) {
		const latency = state.lastPingRoundTripMs !== undefined ? `${state.lastPingRoundTripMs}ms` : "unknown";
		lines.push(`Last ping: ${formatTimestamp(state.lastPingAt)} (${latency})`);
	}

	if (state.lastPongAt) {
		lines.push(`Last pong: ${formatTimestamp(state.lastPongAt)}`);
	}

	if (state.startupError) {
		lines.push(`Startup error: ${state.startupError}`);
	}

	return lines.join("\n");
}

function buildSlackSystemPrompt(): string {
	return [
		"You are Slack Pi, a communications assistant for a distinguished SRE / BOFH.",
		"",
		"Role:",
		"- This is not a coding session.",
		"- Do not assume the user wants code, shell commands, file edits, repo work, or implementation plans unless they explicitly ask for them.",
		"- Your job is to help the user read the active Slack thread and draft concise, accurate Slack-ready replies.",
		"",
		"Style:",
		"- Be concise, direct, and technically precise.",
		"- Prefer short replies unless the user asks for more detail.",
		"- Avoid fluff, filler, and generic corporate tone.",
		"- Preserve correctness and operational nuance.",
		"- A slightly dry BOFH-adjacent tone is fine if it fits the user's intent, but clarity and accuracy come first.",
		"",
		"Workflow:",
		"- When the user refers to the current Slack thread, use slack_get_current_thread if you need context.",
		"- When the user pastes a Slack message link and asks for following channel messages, use slack_get_channel_range.",
		"- Treat any existing composer draft text in the Slack thread result as the user's rough draft or intent.",
		"- The browser integration is read-only. Produce replies for manual copy/paste into Slack.",
		"- Never claim to have sent, inserted, or modified a Slack message.",
		"- Ask clarifying questions only when necessary to avoid an incorrect reply.",
		"",
		"Output:",
		"- By default, provide a single Slack-ready reply with no preamble.",
		"- If the user asks for alternatives, provide 2-3 concise options.",
	].join("\n");
}

function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars - 1)}…`;
}

function singleLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function buildSessionName(label: string, workspace: string | undefined, scope: string | undefined, previewSource: string | undefined): string {
	const parts = [label];

	if (workspace) {
		parts.push(truncateText(singleLine(workspace), 18));
	}

	if (scope) {
		parts.push(truncateText(singleLine(scope), 24));
	}

	const preview = previewSource ? truncateText(singleLine(previewSource), 56) : "";
	if (preview) {
		parts.push(preview);
	}

	return truncateText(parts.join(" · "), 96);
}

function buildSessionNameFromThread(thread: SlackThreadSnapshot): string {
	return buildSessionName(
		"Slack",
		thread.workspace,
		thread.channel || thread.title,
		thread.rootMessage?.text || thread.composerDraftText || thread.title || "Thread",
	);
}

function buildSessionNameFromChannelRange(range: SlackChannelRangeSnapshot): string {
	return buildSessionName(
		"Slack range",
		range.workspace,
		range.channel || range.title,
		range.messages[0]?.text || range.title || "Channel range",
	);
}

function updateSessionNameFromThread(pi: ExtensionAPI, thread: SlackThreadSnapshot): void {
	pi.setSessionName(buildSessionNameFromThread(thread));
}

function updateSessionNameFromChannelRange(pi: ExtensionAPI, range: SlackChannelRangeSnapshot): void {
	pi.setSessionName(buildSessionNameFromChannelRange(range));
}

function estimateMessageChars(message: SlackThreadMessage): number {
	return (
		(message.author?.length ?? 0) +
		(message.timestamp?.length ?? 0) +
		message.text.length +
		32
	);
}

function getThreadCharBudget(ctx: {
	model?: { contextWindow: number } | undefined;
	getContextUsage(): { tokens: number | null } | undefined;
}): number {
	const contextWindow = ctx.model?.contextWindow;
	const usedTokens = ctx.getContextUsage()?.tokens ?? 0;
	if (!contextWindow || contextWindow <= 0) {
		return 24_000;
	}

	const remainingTokens = Math.max(0, contextWindow - usedTokens);
	const budgetTokens = Math.max(1_500, Math.min(12_000, Math.floor(remainingTokens * 0.3)));
	return Math.max(6_000, Math.min(40_000, budgetTokens * 4));
}

function selectMessagesForModel(messages: SlackThreadMessage[], charBudget: number): {
	messages: SlackThreadMessage[];
	omittedCount: number;
} {
	if (messages.length === 0) {
		return { messages: [], omittedCount: 0 };
	}

	const selected: SlackThreadMessage[] = [];
	const usedIndexes = new Set<number>();
	let usedChars = 0;

	const takeIndex = (index: number): boolean => {
		const message = messages[index];
		if (!message || usedIndexes.has(index)) return false;
		const estimated = estimateMessageChars(message);
		if (selected.length > 0 && usedChars + estimated > charBudget) {
			return false;
		}
		selected.push(message);
		usedIndexes.add(index);
		usedChars += estimated;
		return true;
	};

	// Always keep the root message.
	takeIndex(0);

	// Preserve the opening context of the thread.
	for (let index = 1; index < Math.min(messages.length, 6); index++) {
		takeIndex(index);
	}

	// Then preserve recent context from the tail.
	for (let index = messages.length - 1; index >= 0; index--) {
		if (usedIndexes.has(index)) continue;
		if (!takeIndex(index)) break;
	}

	const ordered = selected
		.map((message) => ({ message, index: messages.indexOf(message) }))
		.sort((a, b) => a.index - b.index)
		.map((entry) => entry.message);

	return {
		messages: ordered,
		omittedCount: Math.max(0, messages.length - ordered.length),
	};
}

function formatSlackMessages(lines: string[], messages: SlackThreadMessage[], omittedCount: number): void {
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (!message) continue;
		const number = index + 1;
		let header = `${number}. ${message.author ?? "Unknown"}`;
		if (message.timestamp) {
			header += ` (${message.timestamp})`;
		}
		if (message.isRoot) {
			header += " [root]";
		}
		lines.push("", header, truncateText(message.text, 1_200));
	}

	if (omittedCount > 0) {
		lines.push("", `[${omittedCount} middle or tail message(s) omitted to fit context]`);
	}
}

function formatSlackThreadForModel(snapshot: SlackThreadSnapshot, charBudget: number): string {
	const lines = ["Slack thread"];
	if (snapshot.workspace) lines.push(`Workspace: ${snapshot.workspace}`);
	if (snapshot.channel) lines.push(`Channel: ${snapshot.channel}`);
	if (snapshot.title) lines.push(`Title: ${snapshot.title}`);
	lines.push(`URL: ${snapshot.url}`);
	if (snapshot.reportedMessageCount !== undefined) {
		lines.push(`Reported messages: ${snapshot.reportedMessageCount}`);
	}
	if (snapshot.harvestedViaScroll) {
		lines.push("Capture: harvested by scrolling the virtualized thread pane");
	}

	const { messages, omittedCount } = selectMessagesForModel(snapshot.messages, charBudget);
	formatSlackMessages(lines, messages, omittedCount);

	if (snapshot.composerDraftText?.trim()) {
		lines.push("", "Current composer draft:", truncateText(snapshot.composerDraftText.trim(), 2_000));
	}

	return lines.join("\n");
}

function formatSlackChannelRangeForModel(snapshot: SlackChannelRangeSnapshot, charBudget: number): string {
	const lines = ["Slack channel range"];
	if (snapshot.workspace) lines.push(`Workspace: ${snapshot.workspace}`);
	if (snapshot.channel) lines.push(`Channel: ${snapshot.channel}`);
	if (snapshot.title) lines.push(`Title: ${snapshot.title}`);
	lines.push(`Start URL: ${snapshot.startUrl}`);
	if (snapshot.endUrl) {
		lines.push(`End URL: ${snapshot.endUrl}`);
	}
	if (snapshot.requestedLimit !== undefined) {
		lines.push(`Requested next messages: ${snapshot.requestedLimit}`);
	}
	if (snapshot.harvestedViaScroll) {
		lines.push("Capture: harvested by scrolling the virtualized channel pane");
	}

	const { messages, omittedCount } = selectMessagesForModel(snapshot.messages, charBudget);
	formatSlackMessages(lines, messages, omittedCount);
	return lines.join("\n");
}

function parseSlackChannelReadArgs(args: string): { startUrl: string; endUrl?: string; limit?: number } {
	const trimmed = args.trim();
	if (!trimmed) {
		throw new Error("Usage: /slack-channel-read <start-url> [--next <n>] [--until <end-url>]");
	}

	const tokens = trimmed.match(/"[^"]+"|'[^']+'|\S+/g) ?? [];
	const unquote = (value: string): string => value.replace(/^['"]|['"]$/g, "");
	let startUrl: string | undefined;
	let endUrl: string | undefined;
	let limit: number | undefined;

	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (!token) continue;

		if (token === "--next") {
			const nextToken = tokens[index + 1];
			const parsed = Number.parseInt(unquote(nextToken ?? ""), 10);
			if (!Number.isInteger(parsed) || parsed <= 0) {
				throw new Error("--next requires a positive integer.");
			}
			limit = parsed;
			index += 1;
			continue;
		}

		if (token === "--until") {
			const nextToken = tokens[index + 1];
			if (!nextToken) {
				throw new Error("--until requires a Slack message URL.");
			}
			endUrl = unquote(nextToken);
			index += 1;
			continue;
		}

		if (!startUrl) {
			startUrl = unquote(token);
			continue;
		}

		throw new Error(`Unexpected argument: ${token}`);
	}

	if (!startUrl) {
		throw new Error("A start Slack message URL is required.");
	}

	return { startUrl, endUrl, limit };
}

function createToken(): string {
	return randomBytes(24).toString("hex");
}

async function ensureSharedSecret(tokenFile: string): Promise<{ token: string; created: boolean }> {
	await mkdir(dirname(tokenFile), { recursive: true });

	try {
		const existing = (await readFile(tokenFile, "utf8")).trim();
		if (existing) return { token: existing, created: false };
	} catch (error) {
		if (!isErrnoException(error) || error.code !== "ENOENT") {
			throw error;
		}
	}

	const token = createToken();

	try {
		await writeFile(tokenFile, `${token}\n`, {
			encoding: "utf8",
			mode: 0o600,
			flag: "wx",
		});
		return { token, created: true };
	} catch (error) {
		if (isErrnoException(error) && error.code === "EEXIST") {
			const existing = (await readFile(tokenFile, "utf8")).trim();
			if (existing) return { token: existing, created: false };
		}
		throw error;
	}
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error;
}

function serialize(message: HelloAckMessage | RequestMessage): string {
	return JSON.stringify(message);
}

function rejectAllPending(reason: string): void {
	for (const [id, pending] of state.pendingRequests) {
		clearTimeout(pending.timeout);
		pending.reject(new Error(reason));
		state.pendingRequests.delete(id);
	}
}

function clearActiveChrome(socket: WebSocket): void {
	if (state.activeChrome?.socket !== socket) return;
	state.activeChrome = undefined;
	rejectAllPending("Chrome extension disconnected.");
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
	try {
		socket.close(code, reason);
	} catch {
		socket.terminate();
	}
}

function getChromeRequestTimeoutMs(action: string): number {
	switch (action) {
		case "getCurrentThread":
			return THREAD_REQUEST_TIMEOUT_MS;
		case "getChannelRange":
			return CHANNEL_RANGE_REQUEST_TIMEOUT_MS;
		default:
			return DEFAULT_REQUEST_TIMEOUT_MS;
	}
}

async function requestChrome(action: string, payload: Record<string, unknown> = {}): Promise<ResponseMessage> {
	const chrome = state.activeChrome;
	if (!chrome) {
		throw new Error("Chrome extension is not connected.");
	}

	const id = randomUUID();
	const timeoutMs = getChromeRequestTimeoutMs(action);
	const request: RequestMessage = {
		id,
		type: "request",
		action,
		payload,
	};

	return await new Promise<ResponseMessage>((resolve, reject) => {
		const timeout = setTimeout(() => {
			state.pendingRequests.delete(id);
			reject(new Error(`Timed out waiting for Chrome response to ${action} after ${Math.round(timeoutMs / 1000)}s.`));
		}, timeoutMs);

		state.pendingRequests.set(id, {
			action,
			startedAt: Date.now(),
			timeout,
			resolve,
			reject,
		});

		try {
			chrome.socket.send(serialize(request));
		} catch (error) {
			clearTimeout(timeout);
			state.pendingRequests.delete(id);
			reject(error instanceof Error ? error : new Error(String(error)));
		}
	});
}

function handleResponse(message: ResponseMessage): void {
	const pending = state.pendingRequests.get(message.id);
	if (!pending) return;

	state.pendingRequests.delete(message.id);
	clearTimeout(pending.timeout);

	if (state.activeChrome) {
		state.activeChrome.lastSeenAt = Date.now();
	}

	if (message.ok) {
		pending.resolve(message);
		return;
	}

	const reason = message.error?.message ?? `Chrome returned an error for ${pending.action}.`;
	pending.reject(new Error(reason));
}

function handleAuthenticatedMessage(socket: WebSocket, raw: RawData): void {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawDataToString(raw));
	} catch {
		closeSocket(socket, 1008, "Invalid JSON");
		return;
	}

	if (state.activeChrome?.socket === socket) {
		state.activeChrome.lastSeenAt = Date.now();
	}

	if (isResponseMessage(parsed)) {
		handleResponse(parsed);
		return;
	}

	if (isEventMessage(parsed)) {
		return;
	}
}

function handleHello(socket: WebSocket, raw: RawData, remoteAddress?: string): void {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawDataToString(raw));
	} catch {
		closeSocket(socket, 1008, "Invalid hello JSON");
		return;
	}

	if (!isHelloMessage(parsed)) {
		closeSocket(socket, 1008, "Expected hello message");
		return;
	}

	if (parsed.version !== PROTOCOL_VERSION) {
		closeSocket(socket, 1008, "Protocol version mismatch");
		return;
	}

	if (parsed.token !== state.token) {
		closeSocket(socket, 1008, "Invalid token");
		return;
	}

	if (state.activeChrome && state.activeChrome.socket !== socket) {
		const previousSocket = state.activeChrome.socket;
		closeSocket(previousSocket, 1000, "Replaced by newer Chrome connection");
		clearActiveChrome(previousSocket);
	}

	state.activeChrome = {
		socket,
		connectedAt: Date.now(),
		authenticatedAt: Date.now(),
		lastSeenAt: Date.now(),
		extensionVersion:
			isRecord(parsed.payload) && typeof parsed.payload.extensionVersion === "string"
				? parsed.payload.extensionVersion
				: undefined,
		remoteAddress,
	};

	const ack: HelloAckMessage = {
		type: "hello_ack",
		role: "pi",
		version: PROTOCOL_VERSION,
		payload: {
			instance: "slack-pi",
			protocolVersion: PROTOCOL_VERSION,
		},
	};

	socket.send(serialize(ack));
}

async function startBridge(): Promise<void> {
	state.lifecycle = "starting";
	state.startupError = undefined;

	const tokenResult = await ensureSharedSecret(state.tokenFile);
	state.token = tokenResult.token;
	state.tokenCreated = tokenResult.created;

	const server = new WebSocketServer({
		host: state.host,
		port: state.port,
	});

	await new Promise<void>((resolve, reject) => {
		const onListening = () => {
			server.off("error", onError);
			resolve();
		};
		const onError = (error: Error) => {
			server.off("listening", onListening);
			reject(error);
		};

		server.once("listening", onListening);
		server.once("error", onError);
	});

	state.server = server;
	state.lifecycle = "listening";
	state.wsUrl = `ws://${state.host}:${state.port}`;

	server.on("connection", (socket, request) => {
		const remoteAddress = request.socket.remoteAddress;
		let authenticated = false;
		const helloTimer = setTimeout(() => {
			if (!authenticated) {
				closeSocket(socket, 1008, "Hello timeout");
			}
		}, HELLO_TIMEOUT_MS);

		socket.on("message", (raw) => {
			if (!authenticated) {
				handleHello(socket, raw, remoteAddress);
				authenticated = state.activeChrome?.socket === socket;
				if (authenticated) clearTimeout(helloTimer);
				return;
			}
			handleAuthenticatedMessage(socket, raw);
		});

		socket.on("close", () => {
			clearTimeout(helloTimer);
			clearActiveChrome(socket);
		});

		socket.on("error", () => {
			clearTimeout(helloTimer);
			clearActiveChrome(socket);
		});
	});

	server.on("error", (error) => {
		state.lifecycle = "error";
		state.startupError = error.message;
	});
}

async function stopBridge(): Promise<void> {
	rejectAllPending("Slack Pi bridge is shutting down.");

	if (state.activeChrome) {
		closeSocket(state.activeChrome.socket, 1001, "Slack Pi shutting down");
		state.activeChrome = undefined;
	}

	const server = state.server;
	state.server = undefined;
	state.lifecycle = "stopped";
	startupPromise = undefined;

	if (!server) return;

	await new Promise<void>((resolve) => {
		server.close(() => resolve());
	});
}

async function ensureBridgeStarted(): Promise<void> {
	if (state.server && state.lifecycle === "listening") return;
	if (startupPromise) return await startupPromise;

	startupPromise = startBridge()
		.catch((error) => {
			state.lifecycle = "error";
			state.startupError = error instanceof Error ? error.message : String(error);
			throw error;
		})
		.finally(() => {
			startupPromise = undefined;
		});

	return await startupPromise;
}

async function readCurrentSlackThread(): Promise<SlackThreadSnapshot> {
	await ensureBridgeStarted();
	const response = await requestChrome("getCurrentThread");
	if (!isSlackThreadSnapshot(response.payload)) {
		throw new Error("Chrome returned an invalid Slack thread payload.");
	}
	if (response.payload.messages.length === 0) {
		throw new Error("Chrome returned an empty Slack thread.");
	}
	return response.payload;
}

async function readSlackChannelRange(startUrl: string, endUrl?: string, limit?: number): Promise<SlackChannelRangeSnapshot> {
	await ensureBridgeStarted();
	const response = await requestChrome("getChannelRange", {
		startUrl,
		...(endUrl ? { endUrl } : {}),
		...(limit !== undefined ? { limit } : {}),
	});
	if (!isSlackChannelRangeSnapshot(response.payload)) {
		throw new Error("Chrome returned an invalid Slack channel range payload.");
	}
	if (response.payload.messages.length === 0) {
		throw new Error("Chrome returned an empty Slack channel range.");
	}
	return response.payload;
}

function startupFailureMessage(): string {
	if (state.startupError?.includes("EADDRINUSE")) {
		return `Slack Pi could not start because ${state.wsUrl} is already in use. Another slack-pi instance is probably running.`;
	}
	return `Slack Pi failed to start: ${state.startupError ?? "unknown error"}`;
}

function writeStatus(message: string): void {
	console.log(message);
}

export default function slackPi(pi: ExtensionAPI) {
	pi.on("before_agent_start", async () => {
		return {
			systemPrompt: buildSlackSystemPrompt(),
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		try {
			await ensureBridgeStarted();
		} catch {
			const message = startupFailureMessage();
			if (ctx.hasUI) {
				ctx.ui.notify(message, "error");
			} else {
				console.error(message);
			}
			ctx.shutdown();
			return;
		}

		pi.setActiveTools(["slack_get_current_thread", "slack_get_channel_range"]);
		if (!pi.getSessionName()) {
			pi.setSessionName("Slack Pi");
		}

		if (!ctx.hasUI) return;

		const tokenNote = state.tokenCreated
			? ` New shared secret created at ${state.tokenFile}. Run /slack-status --show-token to reveal it for Chrome setup.`
			: "";
		ctx.ui.notify(`Slack Pi bridge listening on ${state.wsUrl}.${tokenNote}`, "info");
	});

	pi.on("session_shutdown", async () => {
		await stopBridge();
	});

	pi.registerMessageRenderer("slack-read", (message, options, theme) => {
		const content = typeof message.content === "string" ? message.content : String(message.content ?? "");
		const lines = content.split("\n");
		const body = options.expanded ? content : lines.slice(0, 18).join("\n");
		const truncated = !options.expanded && lines.length > 18;

		let text = theme.fg("toolTitle", theme.bold("slack-read"));
		text += `\n${body}`;
		if (truncated) {
			text += `\n${theme.fg("muted", "... expand to view the full Slack thread")}`;
		}
		return new Text(text, 0, 0);
	});

	pi.registerTool({
		name: "slack_get_current_thread",
		label: "Slack Current Thread",
		description:
			"Read the currently open Slack thread from the active Chrome Slack tab, including any existing draft text in the reply composer.",
		promptSnippet:
			"Read the currently open Slack thread from Chrome Slack, including any existing draft text in the reply composer.",
		promptGuidelines: [
			"Use this tool when the user asks about the currently open Slack thread or wants Pi to refine text already typed into the Slack reply box.",
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const thread = await readCurrentSlackThread();
			updateSessionNameFromThread(pi, thread);
			const charBudget = getThreadCharBudget(ctx);
			return {
				content: [{ type: "text", text: formatSlackThreadForModel(thread, charBudget) }],
				details: {
					thread,
					messageCount: thread.messages.length,
					reportedMessageCount: thread.reportedMessageCount,
					composerDraftPresent: Boolean(thread.composerDraftText?.trim()),
					charBudget,
				},
			};
		},
	});

	pi.registerTool({
		name: "slack_get_channel_range",
		label: "Slack Channel Range",
		description:
			"Read a range of channel messages starting from a Slack message link, optionally limited to the next N messages or ending at another Slack message link.",
		promptSnippet:
			"Read channel messages starting from a Slack message link, optionally for the next N messages or until another Slack message link.",
		promptGuidelines: [
			"Use this tool when the user pastes a Slack message link and asks to summarize following channel messages.",
			"Prefer limit for 'next N messages' and endUrl for 'until this other message link'.",
		],
		parameters: Type.Object({
			startUrl: Type.String({ description: "Slack message permalink to start from" }),
			limit: Type.Optional(Type.Integer({ minimum: 1, description: "Number of messages to include starting at startUrl" })),
			endUrl: Type.Optional(Type.String({ description: "Optional Slack message permalink to stop at, inclusive" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const range = await readSlackChannelRange(params.startUrl, params.endUrl, params.limit);
			updateSessionNameFromChannelRange(pi, range);
			const charBudget = getThreadCharBudget(ctx);
			return {
				content: [{ type: "text", text: formatSlackChannelRangeForModel(range, charBudget) }],
				details: {
					range,
					messageCount: range.messages.length,
					requestedLimit: range.requestedLimit,
					charBudget,
				},
			};
		},
	});

	pi.registerCommand("slack-read", {
		description: "Read the current Slack thread and inject it into the session as a visible Slack message",
		handler: async (_args, ctx) => {
			try {
				const thread = await readCurrentSlackThread();
				updateSessionNameFromThread(pi, thread);
				const charBudget = getThreadCharBudget(ctx);
				const content = formatSlackThreadForModel(thread, charBudget);
				pi.sendMessage({
					customType: "slack-read",
					content,
					display: true,
					details: {
						thread,
						messageCount: thread.messages.length,
						reportedMessageCount: thread.reportedMessageCount,
						composerDraftPresent: Boolean(thread.composerDraftText?.trim()),
						charBudget,
					},
				});
				if (ctx.hasUI) {
					ctx.ui.notify("Current Slack thread added to the session.", "info");
				} else {
					writeStatus(content);
				}
			} catch (error) {
				const message = `Slack read failed: ${error instanceof Error ? error.message : String(error)}`;
				if (ctx.hasUI) {
					ctx.ui.notify(message, "error");
				} else {
					console.error(message);
				}
			}
		},
	});

	pi.registerCommand("slack-channel-read", {
		description: "Read a channel message range from a Slack permalink: /slack-channel-read <start-url> [--next N] [--until <end-url>]",
		handler: async (args, ctx) => {
			try {
				const parsed = parseSlackChannelReadArgs(args);
				const range = await readSlackChannelRange(parsed.startUrl, parsed.endUrl, parsed.limit);
				updateSessionNameFromChannelRange(pi, range);
				const charBudget = getThreadCharBudget(ctx);
				const content = formatSlackChannelRangeForModel(range, charBudget);
				pi.sendMessage({
					customType: "slack-read",
					content,
					display: true,
					details: {
						range,
						messageCount: range.messages.length,
						requestedLimit: range.requestedLimit,
						charBudget,
					},
				});
				if (ctx.hasUI) {
					ctx.ui.notify("Slack channel range added to the session.", "info");
				} else {
					writeStatus(content);
				}
			} catch (error) {
				const message = `Slack channel read failed: ${error instanceof Error ? error.message : String(error)}`;
				if (ctx.hasUI) {
					ctx.ui.notify(message, "error");
				} else {
					console.error(message);
				}
			}
		},
	});

	pi.registerCommand("slack-status", {
		description: "Show Slack Pi bridge status (use --show-token to reveal the shared secret)",
		handler: async (args, ctx) => {
			try {
				await ensureBridgeStarted();
			} catch {
				const failure = startupFailureMessage();
				if (ctx.hasUI) {
					ctx.ui.notify(failure, "error");
				} else {
					console.error(failure);
				}
				return;
			}

			const showToken = args.includes("--show-token");
			const message = formatStatus(showToken);
			if (ctx.hasUI) {
				ctx.ui.notify(message, "info");
			} else {
				writeStatus(message);
			}
		},
	});

	pi.registerCommand("slack-ping", {
		description: "Ping the connected Chrome extension over the local Slack Pi bridge",
		handler: async (_args, ctx) => {
			try {
				await ensureBridgeStarted();
			} catch {
				const failure = startupFailureMessage();
				if (ctx.hasUI) {
					ctx.ui.notify(failure, "error");
				} else {
					console.error(failure);
				}
				return;
			}

			if (!state.activeChrome) {
				const message = "Chrome extension is not connected yet. Load the Slack Pi Chrome extension, configure the shared secret, and try again.";
				if (ctx.hasUI) {
					ctx.ui.notify(message, "warning");
				} else {
					writeStatus(message);
				}
				return;
			}

			const startedAt = Date.now();
			try {
				const response = await requestChrome("ping", {
					sentAt: new Date(startedAt).toISOString(),
				});
				state.lastPingAt = startedAt;
				state.lastPongAt = Date.now();
				state.lastPingRoundTripMs = state.lastPongAt - startedAt;

				let details = "";
				if (isRecord(response.payload) && typeof response.payload.now === "string") {
					details = ` Chrome time: ${response.payload.now}`;
				}

				const message = `Slack Pi ping succeeded in ${state.lastPingRoundTripMs}ms.${details}`;
				if (ctx.hasUI) {
					ctx.ui.notify(message, "info");
				} else {
					writeStatus(message);
				}
			} catch (error) {
				const message = `Slack Pi ping failed: ${error instanceof Error ? error.message : String(error)}`;
				if (ctx.hasUI) {
					ctx.ui.notify(message, "error");
				} else {
					console.error(message);
				}
			}
		},
	});
}
