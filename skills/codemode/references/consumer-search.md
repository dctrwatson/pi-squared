# Search retained kubectl captures

This example uses saved `kubectl get statefulsets --output=json` and `kubectl get pods --output=json` captures. The root document is Kubernetes `v1/List`; select `/items`. Item `kind` and `apiVersion` may be present, but are not required.

Use the shared [capture decoder](capture-decoding.md) for both captures. This selection projects each StatefulSet selector and Pod labels, but no workload configuration:

```js
const selections = {
  statefulsets: {
    rows_pointer: "/items",
    metadata_pointers: { api_version: "/apiVersion", kind: "/kind", continuation: "/metadata/continue" },
    identity_pointers: {
      namespace: "/metadata/namespace", name: "/metadata/name",
      desired_replicas: "/spec/replicas", current_replicas: "/status/replicas",
      selector: "/spec/selector",
    },
  },
  pods: {
    rows_pointer: "/items",
    metadata_pointers: { api_version: "/apiVersion", kind: "/kind", continuation: "/metadata/continue" },
    identity_pointers: {
      namespace: "/metadata/namespace", name: "/metadata/name",
      phase: "/status/phase", labels: "/metadata/labels",
    },
  },
};
const scope = {
  command_prefix: ["kubectl", "--context=selected"], namespace: "payments",
  request_suffix: ["--request-timeout=29s"],
  statefulsets: { all_namespaces: true, namespace: null, selector: "app=api", field_selector: null },
  pods: { all_namespaces: false, namespace: "payments", selector: null, field_selector: null },
};
store("saved-consumer-config", { selections, scope });
store("saved-query-selection", selections.statefulsets);
store("saved-statefulset-index", undefined);
store("saved-pod-index", undefined);
```

Run this setup once per capture pair. It stores the selections and scope for later calls and clears stale indexes. Before the Pod decode in a separate call, use `const config = load("saved-consumer-config"); store("saved-query-selection", config.selections.pods);`. A structured helper failure returns without storing an index. Preserve the process envelope for recovery. If the Codemode call itself fails, its writes roll back; do not use a prior index as the new capture. Do not rerun the setup after an index is valid; it clears both indexes.

Decode and checkpoint in one call. Set `indexKey` to `saved-statefulset-index` or `saved-pod-index` for that capture. Clear it before the read so a structured `read_ok: false` result leaves no stale index. Only `read_ok: true` results are stored. The bounded labels and selectors stay in Pi store for matching; the returned value has no rows or full envelope:

```js
const indexKey = "saved-statefulset-index"; // use saved-pod-index for the Pod decode
store(indexKey, undefined);
const decoded = await tools.capture_read({
  saved_capture: load("saved-query-envelope"),
  selection: load("saved-query-selection"),
});
if (!decoded.read_ok) return decoded;
store(indexKey, decoded);
const compactRows = decoded.document?.rows;
const compactProjection = compactRows?.identity_projection;
return {
  read_ok: decoded.read_ok === true,
  status: decoded.status,
  process: decoded.process,
  request: decoded.request ?? null,
  capture_ref: decoded.capture_ref ?? null,
  stage: decoded.stage ?? null,
  decode_error: decoded.decode_error ?? null,
  query_error: decoded.query_error ?? null,
  row_count: compactRows?.count ?? null,
  identity_shown_count: compactProjection?.shown_count ?? null,
  identity_scan_complete: compactProjection?.scan_complete ?? null,
  identities_complete: compactProjection?.identities_complete ?? null,
  limit_reached: compactProjection?.limit_reached ?? null,
};
```

The decoder preserves `details.request`, including `argv` and `started_at`. Do not expect separate target, namespace, resource, or selector fields. Verify `command_prefix` independently from saved argv: it must identify the selected context, wrapper, and target from trusted task context. Read the exact `request_suffix` from saved `request.argv` or a producer contract; it is an execution option, not identity. Do not infer target identity from a tool name or argv. Each resource has its own request namespace scope: use `all_namespaces: true, namespace: null` or `all_namespaces: false` with the exact namespace.

Load scope and call `searchStatefulSetConsumers(load("saved-statefulset-index"), load("saved-pod-index"), load("saved-consumer-config").scope)`. The helper constructs the complete expected argv and compares each saved argv array exactly, including the common prefix, namespace mode, selectors, field selectors, output format, and timeout suffix. It requires an unfiltered Pod request and complete `List` captures. For an all-namespaces capture, it requires a full identity scan and a namespace on each row, then filters to the selected namespace before checking other identity fields. An incomplete identity in another namespace does not make the selected search unknown. A scan or selected identity limit still returns unknown. This local filter does not make the source capture namespace-scoped. The saved `request.started_at` is process start time, not an API observation timestamp.

```js
function searchStatefulSetConsumers(statefulsets, pods, scope) {
  const evidenceFor = (decoded) => ({
    status: decoded?.status ?? null,
    process: decoded?.process ?? null,
    request: decoded?.request ?? null,
    capture: decoded?.capture ?? null,
    capture_ref: decoded?.capture_ref ?? null,
    stage: decoded?.stage ?? null,
    decode_error: decoded?.decode_error ?? null,
    query_error: decoded?.query_error ?? null,
  });
  const evidence = { statefulsets: evidenceFor(statefulsets), pods: evidenceFor(pods) };
  const unknown = (reason) => ({ search_status: "unknown", reason, evidence, candidates: null });
  const stringArray = (value) => Array.isArray(value) && value.length > 0
    && value.every((item) => typeof item === "string" && item.length > 0);
  const validFilter = (value) => value === null || (typeof value === "string" && value.length > 0);
  const validRequestScope = (selection) => selection && typeof selection.all_namespaces === "boolean"
    && (selection.all_namespaces ? selection.namespace === null : selection.namespace === scope.namespace)
    && Object.hasOwn(selection, "selector") && validFilter(selection.selector)
    && Object.hasOwn(selection, "field_selector") && validFilter(selection.field_selector);
  const validScope = scope && typeof scope.namespace === "string" && scope.namespace.length > 0
    && stringArray(scope.command_prefix) && stringArray(scope.request_suffix)
    && validRequestScope(scope.statefulsets) && validRequestScope(scope.pods);
  if (!validScope) return unknown("missing_scope");
  const expectedArgv = (resource, selection) => [
    ...scope.command_prefix, "get", resource,
    ...(selection.all_namespaces ? ["--all-namespaces"] : [`--namespace=${selection.namespace}`]),
    ...(selection.selector === null ? [] : [`--selector=${selection.selector}`]),
    ...(selection.field_selector === null ? [] : [`--field-selector=${selection.field_selector}`]),
    "--output=json", ...scope.request_suffix,
  ];
  const sameArgv = (actual, expected) => Array.isArray(actual) && actual.length === expected.length
    && actual.every((argument, index) => argument === expected[index]);
  const requestMatches = (decoded, resource, selection) => typeof decoded?.request?.started_at === "string"
    && decoded.request.started_at.length > 0 && sameArgv(decoded.request.argv, expectedArgv(resource, selection));
  const list = (decoded, resource, selection) => {
    const rows = decoded?.document?.rows;
    const metadata = decoded?.document?.producer_metadata;
    const projection = rows?.identity_projection;
    const valid = decoded?.read_ok === true && decoded.status?.process === "ok"
      && decoded.status?.capture === "complete" && decoded.status?.decode === "ok"
      && decoded.capture?.saved_eof === true && metadata?.api_version === "v1" && metadata?.kind === "List"
      && (metadata.continuation == null || metadata.continuation === "")
      && rows?.state === "array" && rows.count === projection?.row_count
      && Array.isArray(projection?.items) && projection.items.length === rows.count
      && requestMatches(decoded, resource, selection);
    if (!valid) return null;
    const items = projection.items;
    if (selection.all_namespaces) {
      if (projection.scan_complete !== true || projection.shown_count !== rows.count || projection.limit_reached !== null
          || items.some((row) => !row || typeof row.namespace !== "string")) return null;
      return items.filter((row) => row.namespace === scope.namespace);
    }
    if (projection.identities_complete !== true || !items.every((row) => row.namespace === scope.namespace)) return null;
    return items;
  };
  const workloadRows = list(statefulsets, "statefulsets", scope.statefulsets);
  const podRows = list(pods, "pods", scope.pods);
  if (!workloadRows || !podRows) return unknown("request_or_capture_mismatch");
  if (scope.pods.selector !== null || scope.pods.field_selector !== null) return unknown("filtered_pod_capture");
  const stringMap = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.values(value).every((entry) => typeof entry === "string");
  if (podRows.some((pod) => typeof pod.name !== "string"
      || !["Pending", "Running", "Unknown", "Succeeded", "Failed"].includes(pod.phase) || !stringMap(pod.labels))) {
    return unknown("pod_identity_incomplete");
  }
  const candidates = [];
  for (const workload of workloadRows) {
    const selector = workload.selector;
    const labels = selector?.matchLabels;
    const expressions = selector?.matchExpressions;
    if (typeof workload.name !== "string"
        || !Number.isSafeInteger(workload.desired_replicas) || workload.desired_replicas < 0
        || !Number.isSafeInteger(workload.current_replicas) || workload.current_replicas < 0
        || !stringMap(labels) || Object.keys(labels).length === 0
        || Object.keys(selector).some((key) => !["matchLabels", "matchExpressions"].includes(key))
        || (expressions !== undefined && (!Array.isArray(expressions) || expressions.length > 0))) {
      return unknown("unsupported_selector_or_identity");
    }
    if (workload.desired_replicas === 0 && workload.current_replicas === 0) continue;
    const matchingPods = podRows.filter((pod) => ["Pending", "Running", "Unknown"].includes(pod.phase)
      && Object.entries(labels).every(([key, value]) => pod.labels[key] === value));
    if (matchingPods.length === 0) return unknown("replicas_without_matching_pods");
    candidates.push({
      kind: "StatefulSet", name: workload.name, namespace: scope.namespace,
      desired_replicas: workload.desired_replicas, current_replicas: workload.current_replicas,
    });
  }
  return {
    search_status: "complete",
    scope: {
      command_prefix: scope.command_prefix, namespace: scope.namespace, request_suffix: scope.request_suffix,
      statefulsets: scope.statefulsets, pods: scope.pods,
    },
    evidence,
    candidates,
  };
}
```

An empty candidate list applies only to these exact argv arrays and captures. It does not rule out consumers outside their verified command prefix, selected namespace, resources, selectors, or captures. Pending and Unknown Pods count as current; readiness is not a gate. If a request field, selector, or expected argv is unavailable, report unknown. Do not requery inventory to recover a failed decode.
