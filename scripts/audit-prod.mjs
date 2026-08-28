import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PRODUCTION_AUDIT_POLICY } from "./audit-prod-policy.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEPENDENCY_MAP_NAMES = ["dependencies", "optionalDependencies", "peerDependencies"];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isRecord(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function sameValue(value, expected) {
  if (Object.is(value, expected)) return true;
  if (Array.isArray(value) || Array.isArray(expected)) {
    return Array.isArray(value)
      && Array.isArray(expected)
      && value.length === expected.length
      && value.every((item, index) => sameValue(item, expected[index]));
  }
  if (!isRecord(value) || !isRecord(expected)) return false;

  const valueKeys = Object.keys(value);
  const expectedKeys = Object.keys(expected);
  return valueKeys.length === expectedKeys.length
    && valueKeys.every((key) => Object.hasOwn(expected, key) && sameValue(value[key], expected[key]));
}

function addFailure(failures, message) {
  if (!failures.includes(message)) {
    failures.push(message);
  }
}

function expectedEdge(path, dependency) {
  return PRODUCTION_AUDIT_POLICY.chain.edges.find((edge) => (
    edge.fromPath === path && edge.dependency === dependency
  ));
}

function chainSummary() {
  return PRODUCTION_AUDIT_POLICY.chain.packages
    .map((entry) => `${entry.name}@${entry.version}`)
    .join(" -> ");
}

export function createExpectedPackageState() {
  const lockPackages = { "": { dependencies: {} } };
  const installedPackages = {};
  const manifest = { dependencies: {} };

  for (const entry of PRODUCTION_AUDIT_POLICY.chain.packages) {
    lockPackages[entry.nodePath] = { version: entry.version, dependencies: {} };
    installedPackages[entry.nodePath] = {
      name: entry.name,
      version: entry.version,
      dependencies: {},
      optionalDependencies: {},
      peerDependencies: {},
    };
  }
  for (const edge of PRODUCTION_AUDIT_POLICY.chain.edges) {
    const lockEntry = lockPackages[edge.fromPath];
    if (edge.fromPath === "") {
      manifest.dependencies[edge.dependency] = edge.spec;
    }
    lockEntry.dependencies[edge.dependency] = edge.spec;
    if (edge.fromPath !== "") {
      installedPackages[edge.fromPath].dependencies[edge.dependency] = edge.spec;
    }
  }

  return {
    manifest,
    lockfileVersion: 3,
    lockPackages,
    installedPackages,
  };
}

function verifyEdge(failures, label, dependencies, edge) {
  if (!isRecord(dependencies) || dependencies[edge.dependency] !== edge.spec) {
    addFailure(failures, `${label} does not declare ${edge.dependency}@${edge.spec}`);
  }
}

function verifyPackageStateShape(failures, packageState) {
  if (!isRecord(packageState)) {
    addFailure(failures, "package state is malformed");
    return false;
  }
  if (!isRecord(packageState.manifest?.dependencies)) {
    addFailure(failures, "package.json dependencies are malformed");
  }
  if (packageState.lockfileVersion !== 3) {
    addFailure(failures, "package-lock.json must use lockfile version 3");
  }
  if (!isRecord(packageState.lockPackages)) {
    addFailure(failures, "package-lock packages are malformed");
  }
  if (!isRecord(packageState.installedPackages)) {
    addFailure(failures, "installed package metadata is malformed");
  }
  return failures.length === 0;
}

function dependencyMap(failures, label, value) {
  if (value === undefined) return {};
  if (isRecord(value)) return value;
  addFailure(failures, `${label} is malformed`);
  return null;
}

function verifyInstalledDependencyMaps(failures, path, lockEntry, installed) {
  for (const mapName of DEPENDENCY_MAP_NAMES) {
    const locked = dependencyMap(failures, `package-lock ${path} ${mapName}`, lockEntry[mapName]);
    const installedMap = dependencyMap(failures, `installed ${path} ${mapName}`, installed[mapName]);
    if (locked && installedMap && !sameValue(installedMap, locked)) {
      addFailure(failures, `installed ${path} ${mapName} does not match package-lock`);
    }
  }
}

function verifyNoAdditionalRoutes(failures, packages, sourceLabel, skipDev) {
  const chainNames = new Set(PRODUCTION_AUDIT_POLICY.chain.packages.map((entry) => entry.name));

  for (const [path, entry] of Object.entries(packages)) {
    if (!isRecord(entry) || (skipDev && entry.dev === true)) continue;
    for (const mapName of DEPENDENCY_MAP_NAMES) {
      const dependencies = dependencyMap(failures, `${sourceLabel} ${path || "root"} ${mapName}`, entry[mapName]);
      if (!dependencies) continue;
      for (const dependency of Object.keys(dependencies)) {
        if (!chainNames.has(dependency)) continue;
        const edge = expectedEdge(path, dependency);
        if (!edge || mapName !== "dependencies" || dependencies[dependency] !== edge.spec) {
          addFailure(failures, `${sourceLabel} has an additional production route ${path || "root"} -> ${dependency}`);
        }
      }
    }
  }
}

export function evaluatePackageState(packageState) {
  const failures = [];
  if (!verifyPackageStateShape(failures, packageState)) {
    return failures;
  }

  for (const edge of PRODUCTION_AUDIT_POLICY.chain.edges) {
    const lockEntry = packageState.lockPackages[edge.fromPath];
    if (!isRecord(lockEntry)) {
      addFailure(failures, `package-lock entry ${edge.fromPath || "root"} is missing`);
      continue;
    }
    verifyEdge(failures, `package-lock ${edge.fromPath || "root"}`, lockEntry.dependencies, edge);
    const target = PRODUCTION_AUDIT_POLICY.chain.packages.find((entry) => entry.nodePath === edge.toPath);
    const targetLockEntry = packageState.lockPackages[edge.toPath];
    if (!target || !isRecord(targetLockEntry) || targetLockEntry.version !== target.version) {
      addFailure(failures, `package-lock edge ${edge.fromPath || "root"} -> ${edge.dependency} has an unexpected target`);
    }

    if (edge.fromPath === "") {
      verifyEdge(failures, "package.json root", packageState.manifest.dependencies, edge);
      continue;
    }
    const installed = packageState.installedPackages[edge.fromPath];
    if (!isRecord(installed)) {
      addFailure(failures, `installed package ${edge.fromPath} is missing`);
      continue;
    }
    verifyEdge(failures, `installed ${edge.fromPath}`, installed.dependencies, edge);
  }

  for (const entry of PRODUCTION_AUDIT_POLICY.chain.packages) {
    const lockEntry = packageState.lockPackages[entry.nodePath];
    if (!isRecord(lockEntry) || lockEntry.version !== entry.version) {
      addFailure(failures, `package-lock ${entry.nodePath} does not match ${entry.name}@${entry.version}`);
    }
    const installed = packageState.installedPackages[entry.nodePath];
    if (!isRecord(installed) || installed.name !== entry.name || installed.version !== entry.version) {
      addFailure(failures, `installed ${entry.nodePath} does not match ${entry.name}@${entry.version}`);
    } else if (isRecord(lockEntry)) {
      verifyInstalledDependencyMaps(failures, entry.nodePath, lockEntry, installed);
    }
  }

  verifyNoAdditionalRoutes(failures, packageState.lockPackages, "package-lock", true);
  verifyNoAdditionalRoutes(failures, packageState.installedPackages, "installed package", false);
  return failures;
}

function validateAdvisoryStructure(failures, advisory) {
  const advisoryKeys = [
    "source",
    "name",
    "dependency",
    "title",
    "url",
    "severity",
    "cwe",
    "cvss",
    "range",
  ];
  if (!hasExactKeys(advisory, advisoryKeys)
    || !Number.isSafeInteger(advisory.source)
    || typeof advisory.name !== "string"
    || typeof advisory.dependency !== "string"
    || typeof advisory.title !== "string"
    || typeof advisory.url !== "string"
    || typeof advisory.severity !== "string"
    || typeof advisory.range !== "string"
    || !Array.isArray(advisory.cwe)
    || !advisory.cwe.every((item) => typeof item === "string")
    || !hasExactKeys(advisory.cvss, ["score", "vectorString"])
    || typeof advisory.cvss.score !== "number"
    || typeof advisory.cvss.vectorString !== "string") {
    addFailure(failures, "finding undici has malformed advisory data");
    return false;
  }
  return true;
}

function normalizeAdvisory(advisory) {
  return {
    source: advisory.source,
    name: advisory.name,
    dependency: advisory.dependency,
    title: advisory.title,
    url: advisory.url,
    severity: advisory.severity,
    cwe: advisory.cwe,
    cvss: advisory.cvss,
    range: advisory.range,
  };
}

function validateUndiciAdvisories(failures, via, expectedAdvisories) {
  if (!Array.isArray(via)) {
    addFailure(failures, "finding undici has malformed advisory data");
    return;
  }

  const expectedBySource = new Map(expectedAdvisories.map((advisory) => [advisory.source, advisory]));
  const actualSources = new Set();
  for (const advisory of via) {
    if (!validateAdvisoryStructure(failures, advisory)) continue;
    if (actualSources.has(advisory.source)) {
      addFailure(failures, `finding undici repeats advisory source ${advisory.source}`);
      continue;
    }
    actualSources.add(advisory.source);
    const expected = expectedBySource.get(advisory.source);
    if (!expected) {
      addFailure(failures, `finding undici has unlisted advisory source ${advisory.source}`);
      continue;
    }
    if (!sameValue(normalizeAdvisory(advisory), expected)) {
      addFailure(failures, `finding undici advisory ${advisory.source} fingerprint changed`);
    }
  }

  for (const advisory of expectedAdvisories) {
    if (!actualSources.has(advisory.source)) {
      addFailure(failures, `policy review required: Undici advisory source ${advisory.source} is absent`);
    }
  }
  if (actualSources.size !== expectedAdvisories.length) {
    addFailure(failures, "finding undici has an unexpected advisory count");
  }
}

function validateFindingStructure(failures, name, finding) {
  const findingKeys = [
    "name",
    "severity",
    "isDirect",
    "via",
    "effects",
    "range",
    "nodes",
    "fixAvailable",
  ];
  if (!hasExactKeys(finding, findingKeys)
    || typeof finding.name !== "string"
    || typeof finding.severity !== "string"
    || typeof finding.isDirect !== "boolean"
    || !Array.isArray(finding.via)
    || !Array.isArray(finding.effects)
    || typeof finding.range !== "string"
    || !Array.isArray(finding.nodes)
    || (finding.fixAvailable !== false && !isRecord(finding.fixAvailable))) {
    addFailure(failures, `finding ${name} is malformed`);
    return false;
  }
  return true;
}

function validateFinding(failures, name, finding, expected) {
  if (!validateFindingStructure(failures, name, finding)) return;

  const fields = ["name", "severity", "isDirect", "effects", "range", "nodes", "fixAvailable"];
  for (const field of fields) {
    if (!sameValue(finding[field], expected[field])) {
      addFailure(failures, `finding ${name} field ${field} changed`);
    }
  }
  if (name === "undici") {
    validateUndiciAdvisories(failures, finding.via, expected.advisories);
  } else if (!sameValue(finding.via, expected.via)) {
    addFailure(failures, `finding ${name} field via changed`);
  }
}

function validateMetadata(failures, metadata, findings) {
  if (!hasExactKeys(metadata, ["vulnerabilities", "dependencies"])) {
    addFailure(failures, "npm audit metadata is malformed");
    return;
  }
  const vulnerabilityKeys = ["info", "low", "moderate", "high", "critical", "total"];
  if (!hasExactKeys(metadata.vulnerabilities, vulnerabilityKeys)
    || !vulnerabilityKeys.every((key) => Number.isSafeInteger(metadata.vulnerabilities[key]) && metadata.vulnerabilities[key] >= 0)) {
    addFailure(failures, "npm audit vulnerability metadata is malformed");
  } else {
    const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
    for (const finding of Object.values(findings)) {
      if (isRecord(finding) && Object.hasOwn(counts, finding.severity)) {
        counts[finding.severity] += 1;
      }
    }
    for (const severity of Object.keys(counts)) {
      if (metadata.vulnerabilities[severity] !== counts[severity]) {
        addFailure(failures, `npm audit vulnerability metadata ${severity} does not match findings`);
      }
    }
    if (metadata.vulnerabilities.total !== Object.keys(findings).length) {
      addFailure(failures, "npm audit vulnerability metadata total does not match findings");
    }
  }

  const dependencyKeys = ["prod", "dev", "optional", "peer", "peerOptional", "total"];
  if (!hasExactKeys(metadata.dependencies, dependencyKeys)
    || !dependencyKeys.every((key) => Number.isSafeInteger(metadata.dependencies[key]) && metadata.dependencies[key] >= 0)) {
    addFailure(failures, "npm audit dependency metadata is malformed");
  }
}

export function evaluateAudit(audit, packageState) {
  const failures = evaluatePackageState(packageState);
  if (!hasExactKeys(audit, ["auditReportVersion", "vulnerabilities", "metadata"])
    || audit.auditReportVersion !== PRODUCTION_AUDIT_POLICY.auditReportVersion
    || !isRecord(audit.vulnerabilities)) {
    addFailure(failures, "npm audit output is malformed");
    return { ok: false, failures };
  }

  const findings = audit.vulnerabilities;
  validateMetadata(failures, audit.metadata, findings);
  const expectedNames = Object.keys(PRODUCTION_AUDIT_POLICY.findings);
  const reportedNames = Object.keys(findings);

  if (reportedNames.length === 0) {
    addFailure(failures, "policy review required: allowed findings are absent; remove or update the policy");
  }
  for (const name of reportedNames) {
    if (!Object.hasOwn(PRODUCTION_AUDIT_POLICY.findings, name)) {
      addFailure(failures, `non-allowed production finding ${name}`);
    }
  }
  for (const name of expectedNames) {
    const finding = findings[name];
    if (finding === undefined) {
      addFailure(failures, `policy review required: expected finding ${name} is absent`);
      continue;
    }
    validateFinding(failures, name, finding, PRODUCTION_AUDIT_POLICY.findings[name]);
  }

  return { ok: failures.length === 0, failures };
}

export function formatAuditSummary(result) {
  if (result.ok) {
    return `audit:prod allowed: ${PRODUCTION_AUDIT_POLICY.findings.undici.advisories.length} advisory fingerprints on ${chainSummary()}`;
  }
  const visibleFailures = result.failures.slice(0, 4);
  const remaining = result.failures.length - visibleFailures.length;
  const suffix = remaining > 0 ? `; ${remaining} more` : "";
  return `audit:prod failed: ${visibleFailures.join("; ")}${suffix}`;
}

async function readJson(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`cannot parse ${path}`);
  }
}

export async function readPackageState(root = REPOSITORY_ROOT) {
  const manifest = await readJson(resolve(root, "package.json"));
  const lock = await readJson(resolve(root, "package-lock.json"));
  const installedPackages = {};

  for (const entry of PRODUCTION_AUDIT_POLICY.chain.packages) {
    const packageJson = await readJson(resolve(root, entry.nodePath, "package.json"));
    installedPackages[entry.nodePath] = {
      name: packageJson.name,
      version: packageJson.version,
      dependencies: packageJson.dependencies,
      optionalDependencies: packageJson.optionalDependencies,
      peerDependencies: packageJson.peerDependencies,
    };
  }

  return {
    manifest: { dependencies: manifest.dependencies },
    lockfileVersion: lock.lockfileVersion,
    lockPackages: lock.packages,
    installedPackages,
  };
}

export function runNpmAudit({
  cwd = REPOSITORY_ROOT,
  spawnProcess = spawn,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  policy = PRODUCTION_AUDIT_POLICY.command,
} = {}) {
  return new Promise((resolveRun, rejectRun) => {
    let child;
    try {
      child = spawnProcess("npm", ["audit", "--omit=dev", "--json"], {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      rejectRun(new Error(`cannot start npm audit: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    if (!child || typeof child.once !== "function" || !child.stdout || !child.stderr || typeof child.kill !== "function") {
      rejectRun(new Error("cannot start npm audit: invalid child process"));
      return;
    }

    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let terminationReason;
    let timeoutTimer;
    let forceKillTimer;
    let settled = false;

    const clearTimers = () => {
      if (timeoutTimer !== undefined) clearTimer(timeoutTimer);
      if (forceKillTimer !== undefined) clearTimer(forceKillTimer);
      timeoutTimer = undefined;
      forceKillTimer = undefined;
    };
    const cleanup = () => {
      clearTimers();
      child.stdout.removeListener("data", onStdout);
      child.stderr.removeListener("data", onStderr);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const sendKill = (signal) => {
      try {
        child.kill(signal);
      } catch {
        return false;
      }
      return true;
    };
    const beginTermination = (reason) => {
      if (terminationReason) return;
      terminationReason = reason;
      sendKill("SIGTERM");
      if (settled) return;
      const timer = setTimer(() => {
        sendKill("SIGKILL");
      }, policy.killGraceMs);
      if (settled) {
        clearTimer(timer);
      } else {
        forceKillTimer = timer;
      }
    };
    const capture = (target) => (chunk) => {
      if (terminationReason) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.length;
      if (outputBytes > policy.maxOutputBytes) {
        beginTermination("output-overflow");
        return;
      }
      target.push(buffer);
    };
    const onStdout = capture(stdout);
    const onStderr = capture(stderr);
    const onError = (error) => {
      finish(rejectRun, new Error(`cannot start npm audit: ${error.message}`));
    };
    const onClose = (code, signal) => {
      finish(resolveRun, {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        terminationReason,
      });
    };

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("close", onClose);
    const timer = setTimer(() => {
      beginTermination("timeout");
    }, policy.timeoutMs);
    if (settled) {
      clearTimer(timer);
    } else {
      timeoutTimer = timer;
    }
  });
}

function commandFailure(result) {
  if (!isRecord(result)) return "npm audit returned an invalid process result";
  if (result.terminationReason === "timeout") return "npm audit timed out";
  if (result.terminationReason === "output-overflow") return "npm audit output exceeds the configured limit";
  if (result.terminationReason) return "npm audit was terminated";
  if (result.signal) return `npm audit ended with signal ${result.signal}`;
  if (result.code !== 0 && result.code !== 1) {
    const detail = String(result.stderr ?? "").replaceAll(/\s+/g, " ").trim().slice(0, 240);
    return detail ? `npm audit exited ${result.code}: ${detail}` : `npm audit exited ${result.code}`;
  }
  return null;
}

export async function main({
  runAudit = runNpmAudit,
  readState = readPackageState,
  logger = console,
} = {}) {
  let commandResult;
  try {
    commandResult = await runAudit();
  } catch (error) {
    logger.error(`audit:prod failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const failedCommand = commandFailure(commandResult);
  if (failedCommand) {
    logger.error(`audit:prod failed: ${failedCommand}`);
    return 1;
  }

  let audit;
  try {
    audit = JSON.parse(commandResult.stdout);
  } catch {
    logger.error("audit:prod failed: npm audit output is malformed");
    return 1;
  }

  let packageState;
  try {
    packageState = await readState();
  } catch (error) {
    logger.error(`audit:prod failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const result = evaluateAudit(audit, packageState);
  const output = formatAuditSummary(result);
  if (result.ok) {
    logger.log(output);
    return 0;
  }
  logger.error(output);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
