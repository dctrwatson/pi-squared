import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const SLACK_PI_PORT = 27183;
const SLACK_PI_WS_URL = `ws://127.0.0.1:${SLACK_PI_PORT}`;

function formatStatus(): string {
	return [
		"Slack Pi scaffold loaded.",
		`Planned WebSocket endpoint: ${SLACK_PI_WS_URL}`,
		"Chrome bridge, singleton enforcement, and Slack tools are not implemented yet.",
	].join(" ");
}

export default function slackPi(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.notify(`Slack Pi scaffold loaded (${SLACK_PI_WS_URL})`, "info");
	});

	pi.registerCommand("slack-status", {
		description: "Show Slack Pi scaffold status",
		handler: async (_args, ctx) => {
			const message = formatStatus();
			if (ctx.hasUI) {
				ctx.ui.notify(message, "info");
			} else {
				console.log(message);
			}
		},
	});

	pi.registerCommand("slack-ping", {
		description: "Placeholder Slack bridge ping command",
		handler: async (_args, ctx) => {
			const message = "Slack Pi ping is not implemented yet. Next step: Phase 1 WebSocket handshake.";
			if (ctx.hasUI) {
				ctx.ui.notify(message, "warning");
			} else {
				console.log(message);
			}
		},
	});
}
