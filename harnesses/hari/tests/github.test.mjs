import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { discoverPullRequests, readIssue } from "../src/github.ts";

const issueFields = "url,title,body,state,updatedAt";
const pullRequestFields = "url,title,repository,number,updatedAt";

await test("GitHub intake uses bounded read-only gh commands and reports partial discovery", async (t) => {
  const fixture = await installFakeGh();
  t.after(() => fixture.restore());

  await t.test("reads repository-scoped and fully qualified issue references without a shell", async () => {
    process.env.HARI_GH_BODY = "x".repeat(32_001);
    await fixture.clearLog();

    const scopedIssue = await readIssue("#42", { repository: "acme/service" });
    assert.equal(scopedIssue.repository, "acme/service");
    assert.equal(scopedIssue.number, 42);
    assert.equal(scopedIssue.url, "https://github.com/acme/service/issues/42");
    assert.equal(scopedIssue.body.length, 32_000);
    assert.equal(scopedIssue.bodyTruncated, true);
    assert.equal(scopedIssue.state, "OPEN");
    assert.equal(new Date(scopedIssue.observedAt).toISOString(), scopedIssue.observedAt);

    const explicitUrlIssue = await readIssue("https://github.com/acme/widgets/issues/17");
    assert.equal(explicitUrlIssue.repository, "acme/widgets");
    assert.equal(explicitUrlIssue.number, 17);

    const explicitReferenceIssue = await readIssue("acme/service#18");
    assert.equal(explicitReferenceIssue.repository, "acme/service");
    assert.equal(explicitReferenceIssue.number, 18);

    const overridePrecedenceIssue = await readIssue("https://github.com/acme/widgets/issues/19", { repository: "acme/service" });
    assert.equal(overridePrecedenceIssue.repository, "acme/widgets");
    assert.equal(overridePrecedenceIssue.number, 19);

    assert.deepEqual(await fixture.calls(), [
      ["issue", "view", "42", "--repo", "acme/service", "--json", issueFields],
      ["issue", "view", "17", "--repo", "acme/widgets", "--json", issueFields],
      ["issue", "view", "18", "--repo", "acme/service", "--json", issueFields],
      ["issue", "view", "19", "--repo", "acme/widgets", "--json", issueFields],
    ]);
  });

  await t.test("rejects bare issue references without a repository before invoking gh", async () => {
    await fixture.clearLog();

    for (const reference of ["#7", "7"]) {
      await assert.rejects(
        readIssue(reference),
        /explicit repository option.*owner\/repository#number.*https:\/\/github\.com\/owner\/repository\/issues\/number/i,
      );
    }
    assert.deepEqual(await fixture.calls(), []);
  });

  await t.test("rejects unsafe references and aborted scoped reads before invoking gh", async () => {
    await fixture.clearLog();
    await assert.rejects(readIssue("acme/widgets;echo nope#7"), TypeError);

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(readIssue("#7", { repository: "acme/widgets", signal: controller.signal }), { name: "AbortError" });
    assert.deepEqual(await fixture.calls(), []);
  });

  await t.test("selects, de-duplicates, and explains review, mention, and tracked-link results", async () => {
    process.env.HARI_GH_REVIEW_RESULTS = JSON.stringify([
      pullRequest(4, "Needs review"),
    ]);
    process.env.HARI_GH_MENTION_RESULTS = JSON.stringify([
      pullRequest(4, "Needs review"),
      pullRequest(5, "Question for you"),
      { malformed: true },
    ]);
    process.env.HARI_GH_TRACKED_RESULTS = JSON.stringify([
      pullRequest(5, "Question for you"),
    ]);
    delete process.env.HARI_GH_FAIL_MENTIONS;
    await fixture.clearLog();

    const result = await discoverPullRequests({
      repositories: ["acme/widgets"],
      trackedIssues: ["https://github.com/acme/service/issues/7"],
      limit: 10,
    });

    assert.equal(result.items.length, 2);
    assert.deepEqual(result.items[0].reasons, ["review requested", "mentioned"]);
    assert.deepEqual(result.items[1].reasons, [
      "mentioned",
      "links tracked issue https://github.com/acme/service/issues/7",
    ]);
    assert.match(result.warnings[0], /bounded on-demand snapshot/i);
    assert.ok(result.warnings.some((warning) => /omitted 1 malformed result/i.test(warning)));
    assert.equal(new Date(result.observedAt).toISOString(), result.observedAt);

    const calls = await fixture.calls();
    assert.equal(calls.length, 3);
    assert.ok(calls.some((args) => args.includes("--review-requested")));
    assert.ok(calls.some((args) => args.includes("--mentions")));
    const trackedCall = calls.find((args) => args.includes("https://github.com/acme/service/issues/7"));
    assert.deepEqual(trackedCall, [
      "search",
      "prs",
      "https://github.com/acme/service/issues/7",
      "--state",
      "open",
      "--limit",
      "10",
      "--json",
      pullRequestFields,
    ]);
  });

  await t.test("keeps successful relevance sources when another bounded source fails", async () => {
    process.env.HARI_GH_FAIL_MENTIONS = "1";
    await fixture.clearLog();

    const result = await discoverPullRequests({ repositories: ["acme/widgets"], limit: 2 });
    assert.deepEqual(result.items.map((item) => item.number), [4]);
    assert.ok(result.warnings.some((warning) => /mention search.*unknown/i.test(warning)));
  });

  await t.test("does not scan a default repository without an explicit scope", async () => {
    await fixture.clearLog();
    const result = await discoverPullRequests();

    assert.deepEqual(result.items, []);
    assert.ok(result.warnings.some((warning) => /skipped PR discovery rather than scan a default repository/i.test(warning)));
    assert.deepEqual(await fixture.calls(), []);
  });

  await t.test("warns and skips bare tracked issues without a repository scope", async () => {
    await fixture.clearLog();
    const result = await discoverPullRequests({ trackedIssues: ["#7"] });

    assert.deepEqual(result.items, []);
    assert.ok(result.warnings.some((warning) => /bare github issue references require an explicit repository option/i.test(warning)));
    assert.ok(result.warnings.some((warning) => /skipped PR discovery rather than scan a default repository/i.test(warning)));
    assert.deepEqual(await fixture.calls(), []);
  });
});

function pullRequest(number, title) {
  return {
    url: `https://github.com/acme/widgets/pull/${number}`,
    title,
    repository: { nameWithOwner: "acme/widgets" },
    number,
    updatedAt: "2026-02-03T04:05:06Z",
  };
}

async function installFakeGh() {
  const directory = await mkdtemp(join(tmpdir(), "hari-github-test-"));
  const command = join(directory, "gh");
  const log = join(directory, "calls.jsonl");
  const originalPath = process.env.PATH;
  const originalValues = new Map(
    [
      "HARI_GH_LOG",
      "HARI_GH_BODY",
      "HARI_GH_REVIEW_RESULTS",
      "HARI_GH_MENTION_RESULTS",
      "HARI_GH_TRACKED_RESULTS",
      "HARI_GH_FAIL_MENTIONS",
    ].map((name) => [name, process.env[name]]),
  );

  await writeFile(command, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.HARI_GH_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "issue") {
  const number = args[2];
  const repository = args[4];
  process.stdout.write(JSON.stringify({
    url: "https://github.com/" + repository + "/issues/" + number,
    title: "Issue " + number,
    body: process.env.HARI_GH_BODY || "",
    state: "OPEN",
    updatedAt: "2026-02-03T04:05:06Z"
  }));
} else if (args.includes("--review-requested")) {
  process.stdout.write(process.env.HARI_GH_REVIEW_RESULTS || "[]");
} else if (args.includes("--mentions")) {
  if (process.env.HARI_GH_FAIL_MENTIONS === "1") {
    process.stderr.write("simulated mention failure");
    process.exit(1);
  }
  process.stdout.write(process.env.HARI_GH_MENTION_RESULTS || "[]");
} else {
  process.stdout.write(process.env.HARI_GH_TRACKED_RESULTS || "[]");
}
`);
  await chmod(command, 0o755);
  process.env.PATH = `${directory}:${originalPath ?? ""}`;
  process.env.HARI_GH_LOG = log;

  return {
    async calls() {
      try {
        const content = await readFile(log, "utf8");
        return content.trim() === "" ? [] : content.trim().split("\n").map((line) => JSON.parse(line));
      } catch (error) {
        if (error && typeof error === "object" && error.code === "ENOENT") {
          return [];
        }
        throw error;
      }
    },
    async clearLog() {
      await writeFile(log, "");
    },
    async restore() {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      for (const [name, value] of originalValues) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
      await rm(directory, { recursive: true, force: true });
    },
  };
}
