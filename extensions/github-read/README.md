# Shared GitHub reads

`github_read` is opt-in. Import `createGitHubReadTool()` from `index.ts` and register the returned tool in the harness that needs it. The module's default extension entry does not register a tool. The tool uses the existing `gh` authentication and performs live reads only. It has no cache or write action.

## Actions

Read one issue or pull request:

```json
{"action":"read","url":"https://github.com/acme/widgets/issues/7"}
```

Read one page of issue or PR discussion comments. `source` defaults to `comments`:

```json
{"action":"comments","url":"https://github.com/acme/widgets/pull/8","perPage":5}
```

Read one page of exact changed paths from a pull request. This action reads PR metadata and the changed-files endpoint. It does not read the PR body or discussion comments. Files default to 100 per page; the maximum is 100:

```json
{"action":"files","url":"https://github.com/acme/widgets/pull/8","perPage":100,"patchLimit":512}
```

Each result includes the `baseSha` and `headSha` observed for the PR, `totalChangedFiles`, and the returned paths. The reader checks the PR metadata before and after each file request; `snapshotStable` is false, with a `metadata_mismatch` gap, if these values change. Compare both SHAs across pages and windows. A live PR can change between reads; restart pagination if either SHA changes. An invalid base or head SHA at either metadata check returns the typed `invalid_pull_request_revision` error with no file page or coverage. If initial metadata is invalid, the reader does not request files. If confirmation metadata is invalid, the file request has already occurred, but the page is not returned. Verify that both PR refs are available, then retry.

The tool output stays within 64 KiB. If one API page is too large for one result, it returns a window from that page. `itemOffset` defaults to 0; use the result's `nextItemOffset` with the same `page` and `perPage` until that field is absent. Then use `nextPage`, if present, and set `itemOffset` to 0 or omit it. The tool fetches the page again for each window. `itemOffset` is an index within the selected page, not a new API page. The file capture has a separate 1 MiB ceiling. While a window remains, `eof` is false and `nextPage` is omitted. A later window cannot claim `source_complete` by itself.

`patchLimit` bounds patch text per file in Unicode code points. It defaults to 512, has a maximum of 512, and can be `0` to omit patch text. `patchAvailable` distinguishes an API-omitted patch, such as a binary file, from an empty patch. `patchTruncated` reports a patch limit. Each current or renamed-from path is limited to 512 code points; `pathTruncated` or `previousPathTruncated` and a `gap` coverage result report a longer path. Renamed files include `previousPath`; an absent or overlong old path is a coverage gap.

`coverage` is `source_complete` only when the first page's first window contains every current path and every renamed-from path. `page` describes partial coverage. `gap` is explicit when GitHub reports more than its 3,000-file endpoint limit, a current or renamed-from path is too long, a renamed file has no old path, a page limit is reached, or the file page disagrees with PR metadata. Read every window and page before claiming complete coverage. `eof` says whether the current fully consumed page has another page; it does not mean that prior pages or windows are included.

`reviews` reads PR review submissions. `threads` reads inline review threads and one comment preview per thread. Use `thread_comments` with a thread ID from `threads` to read replies:

```json
{"action":"comments","url":"https://github.com/acme/widgets/pull/8","source":"thread_comments","threadId":"PRRT_Thread123","cursor":"Y3Vyc29y"}
```

REST discussion sources use `page` and `perPage`. GraphQL sources use `cursor` from `nextCursor`; `page` must be 1. Discussion `perPage` is at most 5. Each discussion result describes only the returned page. `eof` says that this page has no continuation; it does not mean that earlier pages are included. Live pages can shift between calls.

## Body limits

The shared readers retain at most 8,000 Unicode code points per source body. A body window returns at most 2,000 code points. Use `bodyOffset` to continue through the retained body. For discussion results, use `entryId` to window one entry; other entries are excerpts of up to 400 code points.

`bodyTruncated` reports source truncation. `bodyWindowTruncated` reports a source or requested-window limit. Results include a notice when a source body may be longer. The text, `details`, and `structuredContent` are bounded to 64 KiB. Read the next page or body window when needed.
