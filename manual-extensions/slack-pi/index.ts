import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import WebSocket, { WebSocketServer, type RawData } from "ws";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 27183;
const PROTOCOL_VERSION = 1;
const HELLO_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 5_000;
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
		Array.isArray(value.messages) &&
		value.messages.every(isSlackThreadMessage) &&
		(value.rootMessage === undefined || isSlackThreadMessage(value.rootMessage))
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

function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars - 1)}…`;
}

function selectMessagesForModel(messages: SlackThreadMessage[], maxMessages = 40): {
	messages: SlackThreadMessage[];
	omittedCount: number;
} {
	if (messages.length <= maxMessages) {
		return { messages, omittedCount: 0 };
	}

	const first = messages[0];
	if (!first) return { messages: [], omittedCount: 0 };

	const tail = messages.slice(-(maxMessages - 1));
	return {
		messages: [first, ...tail],
		omittedCount: messages.length - (1 + tail.length),
	};
}

function formatSlackThreadForModel(snapshot: SlackThreadSnapshot): string {
	const lines = ["Slack thread"];
	if (snapshot.workspace) lines.push(`Workspace: ${snapshot.workspace}`);
	if (snapshot.channel) lines.push(`Channel: ${snapshot.channel}`);
	if (snapshot.title) lines.push(`Title: ${snapshot.title}`);
	lines.push(`URL: ${snapshot.url}`);

	const { messages, omittedCount } = selectMessagesForModel(snapshot.messages);
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
		lines.push("", `[${omittedCount} earlier thread message(s) omitted]`);
	}

	if (snapshot.composerDraftText?.trim()) {
		lines.push("", "Current composer draft:", truncateText(snapshot.composerDraftText.trim(), 2_000));
	}

	return lines.join("\n");
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

async function requestChrome(action: string, payload: Record<string, unknown> = {}): Promise<ResponseMessage> {
	const chrome = state.activeChrome;
	if (!chrome) {
		throw new Error("Chrome extension is not connected.");
	}

	const id = randomUUID();
	const request: RequestMessage = {
		id,
		type: "request",
		action,
		payload,
	};

	return await new Promise<ResponseMessage>((resolve, reject) => {
		const timeout = setTimeout(() => {
			state.pendingRequests.delete(id);
			reject(new Error(`Timed out waiting for Chrome response to ${action}.`));
		}, REQUEST_TIMEOUT_MS);

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

	if (isResponseMessage(parsed)) {
		handleResponse(parsed);
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

		if (!ctx.hasUI) return;

		const tokenNote = state.tokenCreated
			? ` New shared secret created at ${state.tokenFile}. Run /slack-status --show-token to reveal it for Chrome setup.`
			: "";
		ctx.ui.notify(`Slack Pi bridge listening on ${state.wsUrl}.${tokenNote}`, "info");
	});

	pi.on("session_shutdown", async () => {
		await stopBridge();
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
		async execute(_toolCallId, _params) {
			await ensureBridgeStarted();
			const response = await requestChrome("getCurrentThread");
			if (!isSlackThreadSnapshot(response.payload)) {
				throw new Error("Chrome returned an invalid Slack thread payload.");
			}
			if (response.payload.messages.length === 0) {
				throw new Error("Chrome returned an empty Slack thread.");
			}

			const thread = response.payload;
			return {
				content: [{ type: "text", text: formatSlackThreadForModel(thread) }],
				details: {
					thread,
					messageCount: thread.messages.length,
					composerDraftPresent: Boolean(thread.composerDraftText?.trim()),
				},
			};
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
