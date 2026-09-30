import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  CoordinationError, followGitHubItem, readFollowing, readIndex, unfollowGitHubItem,
  type FollowedGitHubItem,
} from "./coordination.ts";
import type { RoleConfig } from "./context.ts";
import {
  readGitHubItem, readGitHubNotification, readGitHubNotifications, readGitHubWork,
  updateGitHubNotification,
} from "./github-access.ts";
import { gitHubItemKey, type GitHubItemReference } from "./github-reference.ts";

const TEXT_LIMIT = 16_000;
const page = Type.Optional(Type.Integer({ minimum: 1, description: "Page number; default: 1" }));
const perPage = Type.Optional(Type.Integer({ minimum: 1, maximum: 25, description: "Items per source/page; default: 10" }));

type MutationQueue = <T>(operation: () => Promise<T>) => Promise<T>;

function response(view: unknown, footer = "") {
  const text = JSON.stringify(view, null, 2);
  return {
    content: [{ type: "text" as const, text: `${text.length <= TEXT_LIMIT ? text : `${text.slice(0, TEXT_LIMIT)}\n[View truncated. Retry with a smaller perPage/limit or read a selected item.]`}${footer ? `\n${footer}` : ""}` }],
    details: { view },
  };
}

function requireHari(config: RoleConfig): string {
  if (config.role !== "hari") throw new CoordinationError("GitHub inbox and local following tools belong to Hari");
  return config.coordinationDir;
}

async function interestContext(directory: string) {
  const [following, index] = await Promise.all([readFollowing(directory), readIndex(directory)]);
  const follows = new Map(following.items.map((item) => [gitHubItemKey(item), item]));
  return (item: { repository: string; item?: GitHubItemReference; number?: number }) => {
    const identity = item.item ?? (item.number === undefined ? undefined : { repository: item.repository, number: item.number });
    const follow = identity ? follows.get(gitHubItemKey(identity)) : undefined;
    const projects = index.projects.filter((project) => project.repository?.toLowerCase() === item.repository.toLowerCase()).map((project) => project.id);
    return {
      ...(follow ? { following: true, ...(follow.note ? { interestNote: follow.note.slice(0, 512), ...(follow.note.length > 512 ? { interestNoteTruncated: true } : {}) } : {}) } : {}),
      ...(projects.length ? { projects: projects.slice(0, 5), ...(projects.length > 5 ? { projectsOmitted: projects.length - 5 } : {}) } : {}),
    };
  };
}

function followingSlice(items: FollowedGitHubItem[], offset: number, limit: number) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 25) {
    throw new CoordinationError("Following offset must be non-negative; limit must be 1 to 25");
  }
  const selected = items.slice(offset, offset + limit);
  return { items: selected, total: items.length, ...(offset + selected.length < items.length ? { nextOffset: offset + selected.length } : {}) };
}

/** Register account observations and local follows only in Hari's role. */
export function registerGitHubInboxTools(pi: ExtensionAPI, getConfig: () => RoleConfig, mutate: MutationQueue): void {
  pi.registerTool({
    name: "hari_follow",
    label: "Hari Following",
    description: "List, follow, or unfollow issue/PR URLs locally in FOLLOWING.md. Optional note records why you care. No GitHub subscription, notification change, project, or assignment is created. Follow only on user request.",
    parameters: Type.Object({
      action: StringEnum(["list", "follow", "unfollow"] as const),
      url: Type.Optional(Type.String({ description: "GitHub issue or PR URL; required for follow/unfollow" })),
      note: Type.Optional(Type.String({ maxLength: 2000, description: "Interest note for follow; empty clears it" })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "List item offset; default: 0" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25, description: "List size; default: 10" })),
    }),
    async execute(_id, params) {
      const directory = requireHari(getConfig());
      if (params.action === "list") {
        const view = followingSlice((await readFollowing(directory)).items, params.offset ?? 0, params.limit ?? 10);
        return response(view, `[${view.nextOffset === undefined ? "eof=true" : `nextOffset=${view.nextOffset}`}; full record: hari_record_page(kind: following, offset: 0)]`);
      }
      if (!params.url) throw new CoordinationError("Follow/unfollow requires a GitHub issue or PR URL");
      if (params.action === "follow") {
        const item = await mutate(() => followGitHubItem(directory, { url: params.url!, ...(params.note === undefined ? {} : { note: params.note }) }));
        return response({ item, local: true });
      }
      if (params.action !== "unfollow") throw new CoordinationError("Unknown following action");
      const removed = await mutate(() => unfollowGitHubItem(directory, params.url!));
      return response({ removed, local: true });
    },
  });

  pi.registerTool({
    name: "hari_github_work",
    label: "Hari GitHub Work",
    description: "Read account-wide authored/assigned issues and PRs, review requests, or current state of locally followed items. Read one issue/PR URL for detail. Account searches report each source's nextPage; nothing is assigned or changed.",
    parameters: Type.Object({
      action: StringEnum(["list", "following", "read"] as const),
      url: Type.Optional(Type.String({ description: "Issue/PR URL; required for read" })),
      source: Type.Optional(StringEnum(["all", "authored", "assigned", "review_requested"] as const)),
      kind: Type.Optional(StringEnum(["all", "issue", "pr"] as const)),
      state: Type.Optional(StringEnum(["open", "closed", "all"] as const)),
      page,
      perPage,
    }),
    async execute(_id, params, signal) {
      const directory = requireHari(getConfig());
      if (params.action === "read") {
        if (!params.url) throw new CoordinationError("Reading an issue or PR requires its URL");
        return response(await readGitHubItem(params.url, { signal }));
      }
      const relevance = await interestContext(directory);
      if (params.action === "list") {
        const work = await readGitHubWork({ source: params.source, kind: params.kind, state: params.state, page: params.page, perPage: params.perPage, signal });
        return response({ ...work, items: work.items.map((item) => ({ ...item, ...relevance(item) })) }, `[Sources: ${work.sources.map((source) => `${source.source}: ${source.nextPage === undefined ? "no next page" : `nextPage=${source.nextPage}`}${source.error ? "; partial/unavailable" : ""}`).join("; ")}]`);
      }
      if (params.action !== "following") throw new CoordinationError("Unknown GitHub work action");
      const pageNumber = params.page ?? 1;
      const size = params.perPage ?? 10;
      if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || !Number.isSafeInteger((pageNumber - 1) * size)) throw new CoordinationError("Following page must be a positive safe integer");
      const selected = followingSlice((await readFollowing(directory)).items, (pageNumber - 1) * size, size);
      const items = [];
      for (const follow of selected.items) {
        signal?.throwIfAborted();
        try {
          const { body: _body, bodyTruncated: _bodyTruncated, ...observation } = await readGitHubItem(follow.url, { signal });
          items.push({ ...observation, ...relevance(observation) });
        } catch (error) {
          if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
          items.push({ ...follow, error: error instanceof Error ? error.message : String(error) });
        }
      }
      return response({ observedAt: new Date().toISOString(), page: pageNumber, perPage: size, total: selected.total, items, ...(selected.nextOffset === undefined ? {} : { nextPage: pageNumber + 1 }) }, `[${selected.nextOffset === undefined ? "eof=true" : `nextPage=${pageNumber + 1}`}]`);
    },
  });

  pi.registerTool({
    name: "hari_notifications",
    label: "Hari GitHub Notifications",
    description: "List notifications, inspect a thread, or mark one thread read/done. Finish page reads and present a digest before using mark_done on its included threads to remove them from the inbox; leave other threads unchanged. Selected read/done requests are also supported. List/read never writes.",
    parameters: Type.Object({
      action: StringEnum(["list", "read", "mark_read", "mark_done"] as const),
      thread: Type.Optional(Type.String({ pattern: "^[1-9][0-9]{0,19}$", description: "Notification thread ID; required except list" })),
      page,
      perPage,
      includeRead: Type.Optional(Type.Boolean({ description: "Include read notifications; default: false" })),
      since: Type.Optional(Type.String({ description: "Only notifications updated after this ISO 8601 timestamp" })),
    }),
    async execute(_id, params, signal) {
      const directory = requireHari(getConfig());
      if (params.action === "list") {
        const relevance = await interestContext(directory);
        const notifications = await readGitHubNotifications({ page: params.page, perPage: params.perPage, includeRead: params.includeRead, since: params.since, signal });
        return response({ ...notifications, items: notifications.items.map((item) => ({ ...item, ...relevance(item) })) }, `[${notifications.nextPage === undefined ? "eof=true" : `nextPage=${notifications.nextPage}`}]`);
      }
      if (!params.thread) throw new CoordinationError("A selected notification thread ID is required");
      if (params.action === "read") {
        const thread = await readGitHubNotification(params.thread, { signal });
        const relevance = await interestContext(directory);
        return response({ ...thread, ...relevance(thread) });
      }
      if (params.action !== "mark_read" && params.action !== "mark_done") throw new CoordinationError("Unknown notification action");
      return response(await updateGitHubNotification(params.thread, params.action, { signal }));
    },
  });
}
