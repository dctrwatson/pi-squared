# Reduce saved metric and event captures

Use `capture_read` from [capture-decoding.md](capture-decoding.md) by default for
bounded projections, grouped numeric summaries, and generic JSONL reads. Set
`format: "jsonl"` to project or reduce each line with observed JSON Pointers. This file
documents specialized metric, JSONL filter, and temporal-matrix reducers when that
bounded result is not enough. These functions do not read artifacts, validate provenance,
or call the source query. For generic per-record processing, use bounded `jsonl_page`
continuations first. For full raw JSONL text or an in-one-pass array beyond the page limits,
use the on-demand [advanced decoder](capture-decoding-advanced.md) only when safe complete
`stdout_text` or a host-approved `artifact_read` route is available. Its `rows` is the full
selected array and `sourceText` is the complete saved document after EOF; neither is
`capture_read`'s default `document.rows.sample`.
Copy only the reducer helper declarations you need from the first JavaScript block into
the same Codemode call as the advanced decoder; they do not replace its EOF/provenance
checks. Save only the bounded evidence below; specialized reducer evidence uses
`load("saved-query-evidence")` for later calculations. Do not save the raw capture or
call the source query again. Read the on-demand [state guide](store-state.md) only for
store limits, cleanup, or recovery beyond the small checkpoint; bounded results still
share the total store limit.

Inspect the producer document first. Set every JSON Pointer from fields that are
present in that document. The functions do not infer a producer schema.

## Bounded reducer helpers

These functions use no `Buffer` or `TextEncoder`. Metric and event pointers use
RFC 6901 syntax. Configure only the mappings that match the observed rows.

```js
const REDUCER_MAX_BYTES = 32 * 1024;
const REDUCER_MAX_GROUPS = 100;
const REDUCER_MAX_FACTS = 256;
const JSONL_MAX_BYTES = 1024 * 1024;
const JSONL_MAX_LINES = 10_000;
const JSONL_MAX_LINE_BYTES = 16 * 1024;

const reducerIsObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const reducerByteLength = (text) => {
  let bytes = 0;
  for (const character of text) {
    const point = character.codePointAt(0);
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
};
const reducerPointer = (pointer) => {
  if (typeof pointer !== "string" || pointer.length > 4096) throw new Error("Pointer must be a string of at most 4096 characters");
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new Error("Pointer must be empty or start with /");
  return pointer.slice(1).split("/").map((part) => {
    if (/~(?![01])/.test(part)) throw new Error("Pointer has an invalid escape");
    return part.replace(/~1/g, "/").replace(/~0/g, "~");
  });
};
const reducerSelect = (root, pointer) => {
  let value = root;
  for (const part of reducerPointer(pointer)) {
    if (Array.isArray(value)) {
      if (!/^(0|[1-9][0-9]*)$/.test(part) || Number(part) >= value.length) return { found: false };
      value = value[Number(part)];
    } else if (reducerIsObject(value) && Object.prototype.hasOwnProperty.call(value, part)) value = value[part];
    else return { found: false };
  }
  return { found: true, value };
};
const reducerScalar = (value) => value === null || typeof value === "string" || typeof value === "boolean"
  || (typeof value === "number" && Number.isFinite(value));
const reducerContext = (input) => ({
  source: input.source ?? null,
  status: { process: input.process_status ?? null, producer: input.producer_status ?? null },
  coverage: input.coverage ?? null,
  capture: input.capture ?? null,
  provenance: input.provenance ?? null,
});
const reducerFits = (value) => reducerByteLength(JSON.stringify(value)) <= REDUCER_MAX_BYTES;
const reducerExactFilter = (filter) => {
  if (!reducerIsObject(filter) || Object.keys(filter).length !== 2
      || typeof filter.pointer !== "string" || !reducerScalar(filter.equals)) {
    throw new Error("A filter must contain only a valid JSON Pointer and an exact scalar equals value");
  }
  reducerPointer(filter.pointer);
  return filter;
};

function reduceMetricEvents(input, mapping) {
  if (!Array.isArray(input.rows) || !reducerIsObject(mapping)) throw new Error("Expected rows and an observed-field mapping");
  if (input.rows.length > 100_000) throw new Error("Rows exceed the reducer scan limit");
  if (mapping.metric !== undefined && !reducerIsObject(mapping.metric)) throw new Error("metric mapping must be an object");
  if (mapping.event !== undefined && !reducerIsObject(mapping.event)) throw new Error("event mapping must be an object");
  const metric = mapping.metric;
  const event = mapping.event;
  const eventFilter = event && event.filter !== undefined ? reducerExactFilter(event.filter) : undefined;
  const evidence = { ...reducerContext(input), metrics: [], metric_events: [], events: [],
    quality: { rows_skipped: 0, non_object_rows_skipped: 0, metric_rows_skipped: 0, invalid_metric_names: 0, invalid_metric_values: 0, invalid_metric_labels: 0, invalid_metric_times: 0, invalid_metric_sources: 0, metric_mapping_complete: true },
    limits: { rows_scanned: 0, metric_facts_truncated: false, events_truncated: false, groups_truncated: false } };
  if (!reducerFits(evidence)) throw new Error("Status and coverage exceed the 32-KiB evidence limit");
  const groups = new Map();
  const selected = (row, pointer) => pointer === undefined ? { found: false } : reducerSelect(row, pointer);
  const metricFact = (row) => {
    const name = selected(row, metric.name_pointer);
    const value = selected(row, metric.value_pointer);
    if (!name.found && !value.found && event) {
      const eventType = selected(row, event.type_pointer);
      if (eventType.found) return null;
    }
    const invalid = { name: false, value: false, labels: false, time: false, source: false };
    if (!name.found || typeof name.value !== "string" || name.value.trim().length === 0) invalid.name = true;
    if (!value.found || typeof value.value !== "number" || !Number.isFinite(value.value)) invalid.value = true;
    let labels = {};
    if (metric.labels_pointer !== undefined) {
      const result = selected(row, metric.labels_pointer);
      if (!result.found || !reducerIsObject(result.value)) invalid.labels = true;
      else {
        const entries = Object.entries(result.value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
        if (entries.length > 16 || entries.some(([key, item]) => key.length > 128 || !reducerScalar(item)
            || (typeof item === "string" && reducerByteLength(item) > 256))) invalid.labels = true;
        else labels = Object.fromEntries(entries);
      }
    }
    const timeResult = selected(row, metric.time_pointer);
    let time = null;
    if (metric.time_pointer !== undefined) {
      const valid = timeResult.found && ((typeof timeResult.value === "string" && timeResult.value.length > 0)
        || (typeof timeResult.value === "number" && Number.isFinite(timeResult.value)));
      if (!valid) invalid.time = true;
      else time = timeResult.value;
    } else if (timeResult.found && reducerScalar(timeResult.value)) time = timeResult.value;
    const sourceResult = selected(row, metric.source_pointer);
    let source = evidence.source;
    if (metric.source_pointer !== undefined) {
      if (!sourceResult.found || typeof sourceResult.value !== "string" || sourceResult.value.length === 0) invalid.source = true;
      else source = sourceResult.value;
    } else if (sourceResult.found && typeof sourceResult.value === "string") source = sourceResult.value;
    if (Object.values(invalid).some(Boolean)) {
      if (invalid.name) evidence.quality.invalid_metric_names += 1;
      if (invalid.value) evidence.quality.invalid_metric_values += 1;
      if (invalid.labels) evidence.quality.invalid_metric_labels += 1;
      if (invalid.time) evidence.quality.invalid_metric_times += 1;
      if (invalid.source) evidence.quality.invalid_metric_sources += 1;
      evidence.quality.rows_skipped += 1;
      evidence.quality.metric_rows_skipped += 1;
      evidence.quality.metric_mapping_complete = false;
      return null;
    }
    return { source, name: name.value, labels, time, value: value.value };
  };
  for (const row of input.rows) {
    evidence.limits.rows_scanned += 1;
    if (!reducerIsObject(row)) {
      evidence.quality.rows_skipped += 1;
      evidence.quality.non_object_rows_skipped += 1;
      if (metric) evidence.quality.metric_mapping_complete = false;
      continue;
    }
    if (metric) {
      const mapped = metricFact(row);
      if (mapped) {
        const { source, name, labels, time, value } = mapped;
        const key = JSON.stringify([source, name, labels]);
        let group = groups.get(key);
        if (!group) {
          if (groups.size >= REDUCER_MAX_GROUPS) evidence.limits.groups_truncated = true;
          else {
            group = { source, metric: name, labels, count: 0, sum: 0, min: value, max: value, first_time: time, last_time: time };
            const candidate = { ...evidence, metrics: [...evidence.metrics, group] };
            if (reducerFits(candidate)) { groups.set(key, group); evidence.metrics.push(group); }
            else evidence.limits.groups_truncated = true;
          }
        }
        if (group) {
          group.count += 1;
          group.sum += value;
          if (!Number.isFinite(group.sum)) throw new Error("Metric sum is outside the finite number range");
          group.min = Math.min(group.min, value);
          group.max = Math.max(group.max, value);
          if (time !== null) {
            if (group.first_time === null) group.first_time = time;
            group.last_time = time;
          }
          const fact = { source, metric: name, labels, time, value };
          const candidate = { ...evidence, metric_events: [...evidence.metric_events, fact] };
          if (evidence.metric_events.length < REDUCER_MAX_FACTS && reducerFits(candidate)) evidence.metric_events.push(fact);
          else evidence.limits.metric_facts_truncated = true;
        }
      }
    }
    if (event) {
      if (eventFilter) {
        const match = selected(row, eventFilter.pointer);
        if (!match.found || match.value !== eventFilter.equals) continue;
      }
      const type = selected(row, event.type_pointer);
      if (!type.found || !reducerScalar(type.value)) continue;
      const sourceResult = selected(row, event.source_pointer);
      const timeResult = selected(row, event.time_pointer);
      const statusResult = selected(row, event.status_pointer);
      const coverageResult = selected(row, event.coverage_pointer);
      const fact = {
        source: sourceResult.found && typeof sourceResult.value === "string" ? sourceResult.value : evidence.source,
        time: timeResult.found && reducerScalar(timeResult.value) ? timeResult.value : null,
        type: type.value,
        status: statusResult.found && reducerScalar(statusResult.value) ? statusResult.value : null,
        coverage: coverageResult.found ? coverageResult.value : evidence.coverage,
      };
      const candidate = { ...evidence, events: [...evidence.events, fact] };
      if (evidence.events.length < REDUCER_MAX_FACTS && reducerFits(candidate)) evidence.events.push(fact);
      else evidence.limits.events_truncated = true;
    }
  }
  if (!reducerFits(evidence)) throw new Error("Reduced evidence exceeds the 32-KiB output limit");
  return evidence;
}

function filterJsonl(sourceText, options) {
  if (typeof sourceText !== "string" || !reducerIsObject(options)) throw new Error("Expected JSONL text and filter options");
  const sourceBytes = reducerByteLength(sourceText);
  if (sourceBytes > JSONL_MAX_BYTES) throw new Error("JSONL capture exceeds the 1-MiB scan limit; do not filter a prefix");
  const maxLines = options.max_lines ?? JSONL_MAX_LINES;
  const maxRecords = options.max_records ?? 200;
  const maxOutputBytes = options.max_output_bytes ?? 16 * 1024;
  if (!Number.isInteger(maxLines) || maxLines < 1 || maxLines > JSONL_MAX_LINES || !Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 200
      || !Number.isInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 16 * 1024) {
    throw new Error("JSONL limits exceed the documented bounds");
  }
  const filter = options.filter === undefined ? undefined : reducerExactFilter(options.filter);
  const context = reducerContext(options);
  const result = { ...context, records: [], scan: { source_bytes: sourceBytes, lines_seen: 0, matches_seen: 0, invalid_lines: 0, complete: true, limit_reached: null, output_bytes: 0 } };
  if (!reducerFits(result) || reducerByteLength(JSON.stringify(result)) + 16 > maxOutputBytes) {
    throw new Error("Status and coverage exceed the JSONL output limit");
  }
  const lines = sourceText.split("\n");
  const fields = options.fields ?? {};
  if (!reducerIsObject(fields) || Object.keys(fields).length > 16) throw new Error("Use at most 16 selected JSONL fields");
  for (const [index, line] of lines.entries()) {
    if (index >= maxLines) { result.scan.complete = false; result.scan.limit_reached = "lines"; break; }
    result.scan.lines_seen += 1;
    if (!line.trim()) continue;
    if (reducerByteLength(line) > JSONL_MAX_LINE_BYTES) {
      result.scan.complete = false; result.scan.limit_reached = "line_bytes"; break;
    }
    let row;
    try { row = JSON.parse(line); }
    catch { result.scan.invalid_lines += 1; continue; }
    if (!reducerIsObject(row)) { result.scan.invalid_lines += 1; continue; }
    if (filter) {
      const match = reducerSelect(row, filter.pointer);
      if (!match.found || match.value !== filter.equals) continue;
    }
    result.scan.matches_seen += 1;
    const project = (pointer) => {
      if (pointer === undefined) return null;
      const picked = reducerSelect(row, pointer);
      return picked.found ? picked.value : null;
    };
    const record = {
      source: options.source_pointer ? project(options.source_pointer) : context.source,
      time: options.time_pointer ? project(options.time_pointer) : null,
      status: options.status_pointer ? project(options.status_pointer) : context.status.producer,
      coverage: options.coverage_pointer ? project(options.coverage_pointer) : context.coverage,
      fields: Object.fromEntries(Object.entries(fields).map(([alias, pointer]) => [alias, project(pointer)])),
    };
    if (Object.values(record.fields).some((value) => !reducerScalar(value) && value !== null)) {
      result.scan.complete = false; result.scan.limit_reached = "field_type"; break;
    }
    const candidate = { ...result, records: [...result.records, record] };
    const bytes = reducerByteLength(JSON.stringify(candidate));
    if (result.records.length >= maxRecords || bytes + 16 > maxOutputBytes) {
      result.scan.complete = false; result.scan.limit_reached = result.records.length >= maxRecords ? "records" : "output_bytes"; break;
    }
    result.records.push(record);
  }
  if (result.scan.complete && result.scan.lines_seen < lines.length) { result.scan.complete = false; result.scan.limit_reached = "lines"; }
  let outputBytes = 0;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    result.scan.output_bytes = outputBytes;
    outputBytes = reducerByteLength(JSON.stringify(result));
  }
  result.scan.output_bytes = outputBytes;
  if (reducerByteLength(JSON.stringify(result)) > maxOutputBytes) throw new Error("JSONL output metadata exceeds its byte limit");
  return result;
}

const TEMPORAL_MATRIX_MAX_CHARS = 262_144;
const TEMPORAL_MATRIX_MAX_CAPTURE_METADATA_CHARS = 8_192;
const TEMPORAL_MATRIX_MAX_CAPTURES = 32;
const TEMPORAL_MATRIX_MAX_SERIES = 10_000;
const TEMPORAL_MATRIX_MAX_SAMPLES = 200_000;
const TEMPORAL_MATRIX_MAX_EVENTS = 10_000;
const TEMPORAL_MATRIX_MAX_FAMILIES = 256;
const TEMPORAL_MATRIX_EVENT_RESERVE_CHARS = 16 * 1024;
const TEMPORAL_MATRIX_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const TEMPORAL_MATRIX_NONFINITE = /^(?:NaN|[+-]?Inf)$/;

function reduceTemporalMatrix(input) {
  if (!reducerIsObject(input) || !Array.isArray(input.captures) || input.captures.length < 1
      || input.captures.length > TEMPORAL_MATRIX_MAX_CAPTURES) {
    throw new Error("Expected 1 to 32 normalized saved captures");
  }
  const captures = input.captures.map((capture, index) => {
    if (!reducerIsObject(capture) || typeof capture.source !== "string" || capture.source.length === 0
        || reducerByteLength(capture.source) > 512 || (capture.query !== null && typeof capture.query !== "string")
        || !(capture.producer_complete === null || typeof capture.producer_complete === "boolean")
        || !Array.isArray(capture.series) || !Array.isArray(capture.observed_events)) {
      throw new Error(`Capture ${index} must include source, query, producer_complete, series, and observed_events`);
    }
    return {
      source: capture.source,
      query: capture.query,
      window: capture.window ?? null,
      coverage: capture.coverage ?? null,
      process_status: capture.process_status ?? null,
      producer_status: capture.producer_status ?? null,
      producer_complete: capture.producer_complete,
      capture: capture.capture ?? null,
      provenance: capture.provenance ?? null,
    };
  });
  const captureMetadataChars = JSON.stringify(captures).length;
  if (captureMetadataChars > TEMPORAL_MATRIX_MAX_CAPTURE_METADATA_CHARS) {
    throw new Error(`TEMPORAL_MATRIX_METADATA_LIMIT: normalized capture metadata exceeds ${TEMPORAL_MATRIX_MAX_CAPTURE_METADATA_CHARS} characters`);
  }
  const result = {
    schema: "temporal-matrix-evidence/v1",
    captures,
    resource_families: [],
    series: [],
    observed_events: [],
    event_identity_gaps: [],
    scan: { series_seen: 0, samples_seen: 0, events_seen: 0, complete: true },
    completeness: { captures: true, producer: true, resource_families: true, series: true, temporal_samples: true, observed_events: true, event_count: false },
    quality: { invalid_series: 0, invalid_samples: 0, invalid_events: 0, series_identity_gaps: 0, event_identity_gaps: 0, duplicate_series: 0, conflicting_series: 0, duplicate_events: 0, conflicting_events: 0 },
    limits: { scan: null, capture_metadata_chars: captureMetadataChars, capture_metadata_max_chars: TEMPORAL_MATRIX_MAX_CAPTURE_METADATA_CHARS, series_retained: true, temporal_bucket_count: null, events_retained: true, event_identity_gaps_retained: true, resource_families_retained: true, output_chars: 0 },
  };
  const encodedLength = (value) => JSON.stringify(value).length;
  const seriesByIdentity = new Map();
  const eventsSeen = new Map();
  const eventIdentityGaps = new Map();
  const families = new Map();
  const rawSamplesByRecord = new WeakMap();
  let compactBucketCount = null;
  let seriesScanStopped = false;
  let eventScanStopped = false;
  for (const capture of captures) {
    if (!reducerIsObject(capture.capture) || capture.capture.state !== "complete" || capture.capture.saved_eof !== true) {
      result.completeness.captures = false;
    }
    if (capture.producer_complete !== true) result.completeness.producer = false;
  }
  const scalarLabels = (value) => {
    if (!reducerIsObject(value)) return null;
    const entries = Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    if (entries.length > 16 || entries.some(([key, item]) => key.length > 128 || !reducerScalar(item)
        || (typeof item === "string" && reducerByteLength(item) > 256))) return null;
    return Object.fromEntries(entries);
  };
  const addFamilySeries = (metric, resource, unit) => {
    const key = JSON.stringify([metric, resource, unit]);
    let family = families.get(key);
    if (!family) {
      if (families.size >= TEMPORAL_MATRIX_MAX_FAMILIES) {
        result.completeness.resource_families = false;
        result.limits.resource_families_retained = false;
        return;
      }
      family = { metric, resource, unit, series_count: 0 };
      families.set(key, family);
      result.resource_families.push(family);
      if (encodedLength(result) > TEMPORAL_MATRIX_MAX_CHARS - TEMPORAL_MATRIX_EVENT_RESERVE_CHARS) {
        families.delete(key);
        result.resource_families.pop();
        result.completeness.resource_families = false;
        result.limits.resource_families_retained = false;
        return;
      }
    }
    family.series_count += 1;
  };
  const requiredIdentity = (labels, required) => {
    if (required !== undefined && (!Array.isArray(required) || required.length > 16
        || required.some((key) => typeof key !== "string" || key.length === 0 || key.length > 128))) return null;
    const requiredLabels = [...new Set(["pod", "container", ...(required ?? [])])].sort();
    return {
      required_labels: requiredLabels,
      identity_gaps: requiredLabels.filter((key) => typeof labels[key] !== "string" || labels[key].length === 0),
    };
  };
  const temporalSamples = (samples, bucketCount = null) => {
    if (bucketCount !== null) {
      const buckets = Array.from({ length: Math.min(bucketCount, samples.length) }, () => null);
      for (let index = 0; index < samples.length; index += 1) {
        const sample = samples[index];
        const bucketIndex = Math.min(buckets.length - 1, Math.floor(index * buckets.length / samples.length));
        let bucket = buckets[bucketIndex];
        if (!bucket) {
          bucket = { count: 0, first: sample, last: sample, min: null, max: null, nonFinite: 0 };
          buckets[bucketIndex] = bucket;
        }
        bucket.count += 1;
        bucket.last = sample;
        const numeric = typeof sample[1] === "number" ? sample[1] : Number(sample[1]);
        if (Number.isFinite(numeric)) {
          if (bucket.min === null || numeric < Number(bucket.min[1])) bucket.min = sample;
          if (bucket.max === null || numeric > Number(bucket.max[1])) bucket.max = sample;
        } else bucket.nonFinite += 1;
      }
      const points = buckets.map((bucket) => [bucket.count, bucket.first[0], bucket.last[0],
        bucket.first[1], bucket.last[1], bucket.min?.[0] ?? null, bucket.min?.[1] ?? null,
        bucket.max?.[0] ?? null, bucket.max?.[1] ?? null, bucket.nonFinite]);
      return { encoding: "time_buckets", exact: false, observed_samples: samples.length, points };
    }
    const runs = [];
    const runSteps = [];
    let runTimesExact = true;
    for (const sample of samples) {
      const last = runs.at(-1);
      if (last && last[2] === sample[1]) {
        const runIndex = runs.length - 1;
        const delta = sample[0] - last[1];
        if (last[3] === 1) {
          runSteps[runIndex] = typeof sample[0] === "number" && typeof last[1] === "number" && Number.isFinite(delta)
            ? delta : null;
        } else if (runSteps[runIndex] === null || delta !== runSteps[runIndex]) runTimesExact = false;
        last[1] = sample[0];
        last[3] += 1;
      } else {
        runs.push([sample[0], sample[0], sample[1], 1]);
        runSteps.push(undefined);
      }
    }
    const useRuns = JSON.stringify(runs).length < JSON.stringify(samples).length;
    const exact = !useRuns || runTimesExact;
    return { encoding: useRuns ? "runs" : "samples", exact, observed_samples: samples.length,
      points: useRuns ? runs : samples };
  };
  const retainSeries = (record) => {
    rawSamplesByRecord.set(record, record._samples);
    delete record._samples;
    const makeCandidate = (series, bucketCount) => ({
      ...result,
      series,
      limits: { ...result.limits, temporal_bucket_count: bucketCount },
    });
    const direct = { ...result, series: [...result.series, record] };
    if (encodedLength(direct) <= TEMPORAL_MATRIX_MAX_CHARS - TEMPORAL_MATRIX_EVENT_RESERVE_CHARS) {
      result.series.push(record);
      if (!record.temporal.exact) result.completeness.temporal_samples = false;
      return true;
    }
    const bucketCounts = compactBucketCount === null ? [8, 4, 2, 1]
      : [...new Set([Math.floor(compactBucketCount / 2), 1])].filter((count) => count >= 1 && count < compactBucketCount);
    for (const bucketCount of bucketCounts) {
      const existing = result.series.map((row) => ({ ...row, temporal: temporalSamples(rawSamplesByRecord.get(row), bucketCount) }));
      const current = { ...record, temporal: temporalSamples(rawSamplesByRecord.get(record), bucketCount) };
      const candidate = makeCandidate([...existing, current], bucketCount);
      if (encodedLength(candidate) <= TEMPORAL_MATRIX_MAX_CHARS - TEMPORAL_MATRIX_EVENT_RESERVE_CHARS) {
        for (let index = 0; index < existing.length; index += 1) result.series[index].temporal = existing[index].temporal;
        record.temporal = current.temporal;
        result.series.push(record);
        compactBucketCount = bucketCount;
        result.limits.temporal_bucket_count = bucketCount;
        result.completeness.temporal_samples = false;
        return true;
      }
    }
    result.limits.series_retained = false;
    result.completeness.series = false;
    result.completeness.temporal_samples = false;
    return false;
  };
  for (let captureIndex = 0; captureIndex < captures.length && !seriesScanStopped; captureIndex += 1) {
    const sourceCapture = input.captures[captureIndex];
    const captureMetadata = captures[captureIndex];
    for (const item of sourceCapture.series) {
      if (result.scan.series_seen >= TEMPORAL_MATRIX_MAX_SERIES) {
        result.scan.complete = false;
        result.completeness.series = false;
        result.completeness.resource_families = false;
        result.limits.scan = "series";
        seriesScanStopped = true;
        break;
      }
      result.scan.series_seen += 1;
      if (!reducerIsObject(item) || typeof item.metric !== "string" || item.metric.length === 0
          || reducerByteLength(item.metric) > 256 || !Array.isArray(item.samples)) {
        result.quality.invalid_series += 1;
        result.completeness.series = false;
        result.completeness.resource_families = false;
        continue;
      }
      const labels = scalarLabels(item.labels);
      const source = item.source ?? captureMetadata.source;
      const identity = labels ? requiredIdentity(labels, item.required_labels) : null;
      if (!labels || !identity || typeof source !== "string" || source.length === 0 || reducerByteLength(source) > 512
          || ["resource", "unit"].some((key) => Object.hasOwn(labels, key) && (typeof labels[key] !== "string" || labels[key].length === 0))) {
        result.quality.invalid_series += 1;
        result.completeness.series = false;
        result.completeness.resource_families = false;
        continue;
      }
      const seriesIdentityGaps = [...identity.identity_gaps];
      if (captureMetadata.query === null) seriesIdentityGaps.push("query");
      if (captureMetadata.window === null) seriesIdentityGaps.push("window");
      if (seriesIdentityGaps.length) {
        result.quality.series_identity_gaps += 1;
        result.completeness.series = false;
        result.completeness.resource_families = false;
      }
      const samples = [];
      let samplesComplete = true;
      for (const point of item.samples) {
        if (result.scan.samples_seen >= TEMPORAL_MATRIX_MAX_SAMPLES) {
          result.scan.complete = false;
          result.limits.scan = "samples";
          result.completeness.temporal_samples = false;
          samplesComplete = false;
          seriesScanStopped = true;
          break;
        }
        result.scan.samples_seen += 1;
        const time = Array.isArray(point) ? point[0] : undefined;
        const rawValue = Array.isArray(point) ? point[1] : undefined;
        const validTime = (typeof time === "string" && time.length > 0) || (typeof time === "number" && Number.isFinite(time));
        const validValue = (typeof rawValue === "number" && Number.isFinite(rawValue))
          || (typeof rawValue === "string" && (TEMPORAL_MATRIX_NUMBER.test(rawValue) || TEMPORAL_MATRIX_NONFINITE.test(rawValue)));
        if (!Array.isArray(point) || point.length !== 2 || !validTime || !validValue) {
          result.quality.invalid_samples += 1;
          result.completeness.series = false;
          result.completeness.temporal_samples = false;
          samplesComplete = false;
          continue;
        }
        samples.push([time, rawValue]);
      }
      if (!samplesComplete) result.completeness.series = false;
      const seriesIdentity = JSON.stringify([source, captureMetadata.query, captureMetadata.window, item.metric, labels,
        identity.required_labels, captureMetadata.query === null || captureMetadata.window === null ? captureIndex : null]);
      const signature = samplesComplete ? JSON.stringify(samples) : JSON.stringify([samples, captureIndex, result.scan.series_seen]);
      const prior = seriesByIdentity.get(seriesIdentity) ?? [];
      const duplicate = prior.find((entry) => entry.signature === signature);
      if (duplicate) {
        result.quality.duplicate_series += 1;
        if (duplicate.retained && !duplicate.record.capture_indexes.includes(captureIndex)) {
          const indexes = [...duplicate.record.capture_indexes, captureIndex];
          const candidate = { ...duplicate.record, capture_indexes: indexes };
          const encoded = JSON.stringify({ ...result, series: result.series.map((row) => row === duplicate.record ? candidate : row) }).length;
          if (encoded <= TEMPORAL_MATRIX_MAX_CHARS - TEMPORAL_MATRIX_EVENT_RESERVE_CHARS) duplicate.record.capture_indexes = indexes;
          else { result.limits.series_retained = false; result.completeness.series = false; }
        }
        continue;
      }
      if (prior.length > 0) {
        result.quality.conflicting_series += 1;
        result.completeness.series = false;
      }
      const entry = { signature, record: null, retained: false };
      prior.push(entry);
      seriesByIdentity.set(seriesIdentity, prior);
      addFamilySeries(item.metric, labels.resource ?? null, labels.unit ?? null);
      const record = {
        source, metric: item.metric, labels, identity_gaps: seriesIdentityGaps,
        temporal: temporalSamples(samples, compactBucketCount),
        _samples: samples, capture_indexes: [captureIndex], variant: prior.length,
      };
      entry.record = record;
      entry.retained = retainSeries(record);
    }
  }
  for (let captureIndex = 0; captureIndex < captures.length && !eventScanStopped; captureIndex += 1) {
    const sourceCapture = input.captures[captureIndex];
    const captureMetadata = captures[captureIndex];
    for (const item of sourceCapture.observed_events) {
      if (result.scan.events_seen >= TEMPORAL_MATRIX_MAX_EVENTS) {
        result.scan.complete = false;
        result.completeness.observed_events = false;
        result.limits.scan = "events";
        eventScanStopped = true;
        break;
      }
      result.scan.events_seen += 1;
      const labels = item && item.labels === undefined ? {} : scalarLabels(item?.labels);
      const source = item?.source ?? captureMetadata.source;
      const identity = labels ? requiredIdentity(labels, item?.required_labels) : null;
      const validTime = (typeof item?.time === "string" && item.time.length > 0)
        || (typeof item?.time === "number" && Number.isFinite(item.time));
      const validObservedAt = item?.observed_at === undefined || item.observed_at === null
        || (typeof item.observed_at === "string" && item.observed_at.length > 0)
        || (typeof item.observed_at === "number" && Number.isFinite(item.observed_at));
      const status = item?.status ?? null;
      if (!reducerIsObject(item) || !labels || !identity || typeof source !== "string" || source.length === 0
          || reducerByteLength(source) > 512 || typeof item.type !== "string" || item.type.length === 0 || !validTime
          || !validObservedAt || !(item.status === undefined || item.status === null || reducerScalar(item.status))) {
        result.quality.invalid_events += 1;
        result.completeness.observed_events = false;
        continue;
      }
      const eventGaps = [...identity.identity_gaps];
      const validIdentity = (typeof item.identity === "string" && item.identity.length > 0)
        || (typeof item.identity === "number" && Number.isFinite(item.identity));
      if (!validIdentity) eventGaps.push("event_identity");
      if (eventGaps.length) {
        result.quality.event_identity_gaps += 1;
        result.completeness.observed_events = false;
        const gapKey = JSON.stringify([source, item.type, status, labels, eventGaps]);
        let gapEntry = eventIdentityGaps.get(gapKey);
        const observedAt = item.observed_at ?? null;
        if (!gapEntry) {
          const gap = { source, type: item.type, status, labels, identity_gaps: eventGaps,
            observed_samples: 0, first_observed_at: null, last_observed_at: null };
          gapEntry = { record: gap, retained: false };
          eventIdentityGaps.set(gapKey, gapEntry);
          const candidate = { ...result, event_identity_gaps: [...result.event_identity_gaps, gap] };
          if (result.limits.event_identity_gaps_retained
              && encodedLength(candidate) <= TEMPORAL_MATRIX_MAX_CHARS - 256) {
            result.event_identity_gaps.push(gap);
            gapEntry.retained = true;
          } else result.limits.event_identity_gaps_retained = false;
        }
        const gap = gapEntry.record;
        gap.observed_samples += 1;
        if (observedAt !== null) {
          if (gap.first_observed_at === null) gap.first_observed_at = observedAt;
          gap.last_observed_at = observedAt;
        }
        continue;
      }
      const event = {
        source, time: item.time, type: item.type, identity: item.identity, status, labels,
        observations: 1, first_observed_at: item.observed_at ?? null, last_observed_at: item.observed_at ?? null,
        capture_indexes: [captureIndex],
      };
      const eventKey = JSON.stringify([source, item.type, item.identity, labels]);
      const prior = eventsSeen.get(eventKey);
      if (prior) {
        result.quality.duplicate_events += 1;
        prior.record.observations += 1;
        if (prior.record.time !== item.time || prior.record.status !== status) {
          result.quality.conflicting_events += 1;
          result.completeness.observed_events = false;
        }
        const observedAt = item.observed_at ?? null;
        if (observedAt !== null) {
          if (prior.record.first_observed_at === null) prior.record.first_observed_at = observedAt;
          prior.record.last_observed_at = observedAt;
        }
        if (prior.retained && !prior.record.capture_indexes.includes(captureIndex)) {
          const indexes = [...prior.record.capture_indexes, captureIndex];
          const candidate = { ...prior.record, capture_indexes: indexes };
          const encoded = JSON.stringify({ ...result,
            observed_events: result.observed_events.map((row) => row === prior.record ? candidate : row) }).length;
          if (encoded <= TEMPORAL_MATRIX_MAX_CHARS - 256) prior.record.capture_indexes = indexes;
          else { result.limits.events_retained = false; result.completeness.observed_events = false; }
        }
        continue;
      }
      const entry = { record: event, retained: false };
      eventsSeen.set(eventKey, entry);
      const candidate = { ...result, observed_events: [...result.observed_events, event] };
      if (result.limits.events_retained && encodedLength(candidate) <= TEMPORAL_MATRIX_MAX_CHARS - 256) {
        result.observed_events.push(event);
        entry.retained = true;
      } else { result.limits.events_retained = false; result.completeness.observed_events = false; }
    }
  }
  if (result.limits.scan === "series" || result.limits.scan === "samples") {
    result.completeness.series = false;
    result.completeness.resource_families = false;
  }
  if (result.limits.scan === "events") result.completeness.observed_events = false;
  result.resource_families.sort((left, right) => {
    for (const key of ["metric", "resource", "unit"]) {
      const a = left[key] ?? "";
      const b = right[key] ?? "";
      if (a < b) return -1;
      if (a > b) return 1;
    }
    return 0;
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const outputChars = encodedLength(result);
    if (result.limits.output_chars === outputChars) break;
    result.limits.output_chars = outputChars;
  }
  if (encodedLength(result) > TEMPORAL_MATRIX_MAX_CHARS) throw new Error("Temporal matrix evidence exceeds the 262144-character store limit");
  return result;
}
```

## Reduce once and retain evidence

Use the full-row variables from the on-demand
[advanced decoder](capture-decoding-advanced.md). After its verified EOF and successful
JSON parse, insert a reducer call before the final `return decoded;`. `rows` is the
entire array selected by `rows_pointer`; `producerMetadata`, `original`,
`capture(savedEof)`, and `provenance` retain the observed metadata and source evidence.
Map only fields observed in the document. Do not substitute the helper's ten-row
`sample` or a capped projection for `rows`. For example, if rows contain `name`,
`value`, `labels`, and `timestamp` fields, and event rows contain `event`, `workload`,
and `status` fields:

```js
const evidence = reduceMetricEvents({
  rows,
  source: producerMetadata.source ?? null,
  process_status: original.process,
  producer_status: producerMetadata.status ?? null,
  coverage: producerMetadata.coverage ?? null,
  capture: capture(true),
  provenance,
}, {
  metric: {
    name_pointer: "/name", value_pointer: "/value", labels_pointer: "/labels",
    time_pointer: "/timestamp", source_pointer: "/source",
  },
  event: {
    type_pointer: "/event", time_pointer: "/timestamp", status_pointer: "/status",
    filter: { pointer: "/workload", equals: "api" },
  },
});
store("saved-query-evidence", evidence);
```

`process_status`, producer `status`, `coverage`, source capture state, and artifact
`provenance` stay in separate fields. `quality.rows_skipped` and
`quality.non_object_rows_skipped` report unusable rows. `quality.metric_rows_skipped`
and its invalid-name, value, label, time, and source counts report bad mapped metric
rows. Any such row sets `quality.metric_mapping_complete` to false. In mixed metric
and event rows, the configured event type pointer distinguishes event rows with no
metric fields from malformed metric rows. Group totals include valid mapped rows
only; `metric_events` retains a bounded sample with its source and event time. These
mapping counts and the reducer's scan/output limits do not establish producer
coverage.

For a saved JSONL stream, use the advanced decoder's exact `sourceText` after safe
complete stdout or granted artifact pages reach EOF, and branch before its object
`JSON.parse(sourceText)` step. Do not parse a preview or pass a prefix to the filter.
Call `filterJsonl(sourceText, options)` with an observed filter pointer and only the
fields needed for the next calculation. Use observed producer metadata, or `null` when
it is not available:

```js
const logs = filterJsonl(sourceText, {
  source: "observed-log-source",
  process_status: original.process,
  producer_status: null,
  coverage: null,
  capture: capture(true),
  provenance: provenance ?? null,
  filter: { pointer: "/workload", equals: "api" },
  source_pointer: "/source", time_pointer: "/timestamp", status_pointer: "/status",
  fields: { event: "/event", instance: "/instance" },
  max_lines: 10_000, max_records: 100, max_output_bytes: 8192,
});
store("saved-query-log-evidence", logs);
```

JSONL limits are 1 MiB per capture, 10,000 lines, 16 KiB per line, 200 records,
and 16 KiB of output. The filter rejects an oversized capture instead of parsing
a prefix. A filter must contain exactly a valid JSON Pointer and a scalar `equals`
value; an invalid filter fails instead of selecting every row. `scan.complete`
means only that the saved text was scanned to its end under these limits. It does
not mean that every line was valid or matched, and it does not change process
status, producer status, source capture state, or producer coverage. Check
`scan.invalid_lines` separately.

## Reduce bounded temporal matrices

Use `reduceTemporalMatrix` when a saved matrix needs temporal samples and the
scalar reducer's 100-group and 256-fact limits are too small. First decode each saved
capture to EOF with the on-demand [advanced decoder](capture-decoding-advanced.md).
Map only fields seen in each producer document; do not infer metric names, labels,
query, window, or status from a tool name. Keep one capture entry per saved source
result so each query, window, process and producer status, capture state, and artifact
provenance stay available. Build `normalizedCaptures` from the advanced template's full
`document`, `producerMetadata`, `original`, `rows`, `capture(true)`, and `provenance`,
then call the adapter before returning. `capture_read`'s `document.rows.sample` is only
a bounded preview and cannot recover rows that were not returned. Set
`producer_complete` only from an explicit observed producer contract field; use `null`
when unknown. Never infer it by comparing `row_count` to decoded rows or from
`truncated` alone.

```js
const evidence = reduceTemporalMatrix({ captures: normalizedCaptures });
store("saved-temporal-matrix-evidence", evidence);
return { schema: evidence.schema, completeness: evidence.completeness, limits: evidence.limits };
```

Each capture has `source`, `query` (a string or `null`), `window`, `coverage`,
`process_status`, `producer_status`, `producer_complete` (an observed `true` or
`false`, or `null` when unknown), `capture`, `provenance`, `series`, and
`observed_events`. Map each matrix series to `{ metric, labels, samples,
required_labels? }`; every series must have observed `pod` and `container` labels.
Only list `resource` or `unit` in `required_labels` when the producer family
requires them. A missing optional label stays absent from `labels`; it does not
get a guessed value. A missing required label, query, or window appears in
`identity_gaps` and makes series and family completeness false. Each sample is
`[time, value]`.

Map events to `{ source?, time, type, identity?, status?, observed_at?, labels?,
required_labels? }`. `identity` must come from a stable event identifier in the
capture, not a periodic scrape time. `time` is the event time; `observed_at` can
hold each sample time. Repeated samples with the same source, type, identity, and
labels form one observed event with an observation count. If no stable identity
is available, the reducer groups the samples under `event_identity_gaps`; it does
not count each positive sample as a new event. Missing event label identities are
also explicit gaps. Map only fields seen in the saved captures. Keep separate
capture entries when sources, queries, windows, or provenance differ.

The named result is `temporal-matrix-evidence/v1`. Series retain source, metric,
all observed labels, capture indexes, and temporal evidence. Resource-family
counts use the metric, observed resource, and observed unit tuple. Missing
optional dimensions appear as `null` in the family count, not as invented labels.
Exact duplicate series are stored once; conflicting histories keep separate
variants. Stable event identities are deduplicated. `completeness.captures` and
`completeness.producer` stay separate from reducer coverage. `event_count` is
always incomplete: observed events are not a complete event count.

Temporal summaries use raw points or run-length boundaries when these are
smaller. A run stores `[start_time, end_time, value, observed_samples]`. Its
`exact` flag is true only
when its sample times are reconstructible: each run has at most two points, or
its numeric times have a constant step. A run with unrecoverable interior times
has `exact: false` and makes `completeness.temporal_samples` false. If raw points
do not fit, the adapter uses time buckets. Each bucket stores
`[count, first_time, last_time, first_value, last_value, min_time, min_value,
max_time, max_value, non_finite_count]`. Non-finite raw values stay counted.
Buckets also make `completeness.temporal_samples` false. Check `exact`,
`completeness`, and `limits` before use.

The adapter admits at most 8,192 characters of serialized normalized capture
metadata across the complete `captures` array. This includes source, query,
window, coverage, statuses, capture state, and provenance. The result reports the
accepted size and bound in `limits.capture_metadata_chars` and
`limits.capture_metadata_max_chars`. The capture decoder also limits selected
producer metadata to 8,192 characters. If the reducer's aggregate metadata
exceeds its admission limit, it throws `TEMPORAL_MATRIX_METADATA_LIMIT` before
scanning. It does not truncate or omit metadata and does not return partial
evidence. This admission error is different from scan or output limits, which are
reported in the result. The helper accepts bounded decoded input; it is not
suitable for arbitrary-size sources.

The adapter scans 1 to 32 captures, 10,000 series, 200,000 samples, 10,000
events, and 256 metric/resource/unit families. Labels have at most 16 scalar
fields, with keys up to 128 characters and string values up to 256 UTF-8 bytes.
Metric names are limited to 256 UTF-8 bytes and source names to 512. Its JSON
result never exceeds Pi's documented [262,144-character per-value `store()`
bound](https://pi-agent-docs.pages.dev/codemode#store-values). A scan or output
limit marks its corresponding completeness field false; it does not discard
admitted capture metadata or claim complete coverage. Keep the result in
`store()` only while later work needs it, and use `load()` for those calculations.
The per-value bound does not reserve total store space. Remove obsolete matrices
after preserving needed facts and source references. Do not store raw captures,
print full previews, or rerun a query to enlarge a result.

A later calculation uses only retained evidence. It makes no tool call and does
not reread the artifact or rerun the query:

```js
const evidence = load("saved-query-evidence");
if (!evidence) return { ok: false, error: "No saved query evidence" };
const rates = evidence.metrics.map((metric) => ({
  source: metric.source,
  signal: metric.metric,
  labels: metric.labels,
  mean: metric.count ? metric.sum / metric.count : null,
  event_times: evidence.metric_events
    .filter((event) => event.source === metric.source && event.metric === metric.metric
      && JSON.stringify(event.labels) === JSON.stringify(metric.labels))
    .map((event) => event.time),
}));
return { process_status: evidence.status.process, producer_status: evidence.status.producer, coverage: evidence.coverage, rates };
```

The retained event times are bounded samples. Check the reducer limits and
capture, status, and coverage fields before treating a calculation as complete.
