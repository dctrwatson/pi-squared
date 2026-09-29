import test from "node:test";
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { mkdtemp, open, readFile, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { createAgentReadTool, decodeBytePage, readBytePage } from "../../extensions/agent-tools/read.ts";

const text = (result) => result.content[0].text;
const execute = (tool, input, cwd, signal) => tool.execute("read-page", input, signal, undefined, { cwd });

async function withDirectory(callback) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-agent-read-pages-"));
  try {
    await writeFile(join(cwd, "source"), "preflight");
    return await callback(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function fakeFile(bytes, options = {}) {
  const size = options.size ?? bytes.length;
  const state = { reads: [], stats: 0, closes: 0, flags: undefined, buffers: new Set() };
  const metadata = { dev: 1n, ino: 2n, size: BigInt(size), mtimeNs: 3n, ctimeNs: 4n };
  const handle = {
    async stat(input) {
      assert.deepEqual(input, { bigint: true });
      state.stats += 1;
      return { ...metadata, ...options.stat?.(state), isFile: () => options.regular !== false };
    },
    async read(buffer, offset, length, position) {
      assert.equal(Number.isSafeInteger(position), true);
      assert.ok(length > 0);
      assert.ok(length <= (options.readLimit ?? 65_536));
      assert.ok(position + length <= size);
      state.reads.push({ offset, length, position });
      state.buffers.add(buffer);
      if (options.throwRead) throw options.throwRead;
      const count = Math.min(length, options.shortRead ?? length, size - position);
      if (options.fill) options.fill(buffer, offset, count, position);
      else bytes.copy(buffer, offset, position, position + count);
      await options.afterRead?.(state);
      return { bytesRead: options.zeroRead ? 0 : count };
    },
    async close() { state.closes += 1; await options.afterClose?.(); },
  };
  return {
    state,
    handle,
    openFile: async (_path, flags) => {
      state.flags = flags;
      assert.equal(flags, constants.O_RDONLY | constants.O_NONBLOCK);
      return handle;
    },
  };
}

async function runFake(cwd, bytes, input = {}, options = {}, signal) {
  const fake = fakeFile(bytes, options);
  const result = await execute(createAgentReadTool({ openFile: fake.openFile }), { path: "source", ...input }, cwd, signal);
  assert.equal(fake.state.closes, 1);
  return { result, ...fake };
}

test("read defaults to numbered 200-line and 16384-source-byte pages", async () => {
  await withDirectory(async (cwd) => {
    const source = Buffer.from("x\n".repeat(201));
    const { result, state } = await runFake(cwd, source);
    assert.equal(result.details.end_line, 200);
    assert.equal(result.details.total_lines, null);
    assert.equal(result.details.has_more, true);
    assert.equal(result.details.next_start_line, 201);
    assert.equal(result.details.limited_by, "lines");
    assert.ok(text(result).startsWith("  1 │ x\n  2 │ x\n"));
    assert.equal(state.reads.length, 1);
    const larger = Buffer.from(`${"x".repeat(100)}\n`.repeat(201));
    const limited = (await runFake(cwd, larger)).result;
    assert.equal(limited.details.end_line, 162);
    assert.equal(limited.details.source_bytes, 16_362);
    assert.equal(limited.details.limited_by, "bytes");
    assert.equal(limited.details.total_lines, null);
    for (const encoding of ["utf8", "base64"]) {
      const bytes = await runFake(cwd, Buffer.alloc(40_000, 65), { mode: "bytes", encoding }, { readLimit: 16_387 });
      assert.equal(bytes.result.details.end_byte, 16_384);
      assert.equal(bytes.result.details.next_start_byte, 16_384);
      assert.equal(bytes.result.details.has_more, true);
      assert.equal(bytes.state.reads[0].length, encoding === "utf8" ? 16_387 : 16_384);
      assert.equal("total_lines" in bytes.result.details, false);
    }
  });
});

test("read emits the exact four-line example without claiming a readahead line total", async () => {
  await withDirectory(async (cwd) => {
    const { result, state } = await runFake(cwd, Buffer.from("one\ntwo\nthree\nfour\n"), { start_line: 2, max_lines: 2 });
    assert.equal(text(result), "2 │ two\n3 │ three\n\n[lines 2-3; next_start_line=4; eof=false]");
    assert.equal(result.details.total_lines, null);
    assert.equal(result.details.has_more, true);
    assert.equal(result.details.limited_by, "lines");
    assert.equal(result.details.source_bytes, 10);
    assert.equal(result.details.formatted_bytes, Buffer.byteLength(text(result)));
    assert.equal(state.reads.length, 1);
  });
});

test("read stops after the requested lines instead of reading later blocks", async () => {
  await withDirectory(async (cwd) => {
    const source = Buffer.from(`ok\n${"x".repeat(200_000)}`);
    const { result, state } = await runFake(cwd, source, { max_lines: 1 });
    assert.equal(text(result), "1 │ ok\n\n[lines 1-1; next_start_line=2; eof=false]");
    assert.equal(result.details.total_lines, null);
    assert.equal(state.reads.length, 1);
    assert.equal(state.reads[0].length, 65_536);
  });
});

test("read counts logical LF lines only after logical EOF", async () => {
  await withDirectory(async (cwd) => {
    for (const [source, total] of [["", 0], ["a", 1], ["a\n", 1], ["a\n\n", 2], ["a\r\nb", 2]]) {
      for (const start_line of [1, 10]) {
        const { result } = await runFake(cwd, Buffer.from(source), { start_line });
        assert.equal(result.details.total_lines, total);
        assert.equal(result.details.has_more, false);
        assert.equal(result.details.next_start_line, null);
        if (start_line === 10 || total === 0) assert.equal(result.details.start_line, null);
      }
    }
    const crlf = (await runFake(cwd, Buffer.from(" \t\r\nx\r\n"), { show_line_numbers: false })).result;
    assert.equal(text(crlf), " \t\r\nx\r\n\n[lines 1-2; next_start_line=null; eof=true]");
  });
});

test("read reports a long requested line before scanning its remaining blocks", async () => {
  await withDirectory(async (cwd) => {
    const { result, state } = await runFake(cwd, Buffer.from(`é\n${"x".repeat(500_000)}`), { start_line: 2 });
    assert.equal(result.details.error.code, "LINE_TOO_LONG");
    assert.equal(result.details.error.line, 2);
    assert.equal(result.details.error.byte_offset, 3);
    assert.equal(state.reads.length, 1);
    const required = (await runFake(cwd, Buffer.from(`é\n${"x".repeat(50_000)}`), { start_line: 2 })).result;
    assert.equal(text(required), "[read error: LINE_TOO_LONG; The first requested line exceeds max_bytes; line=2; byte_offset=3]");
  });
});

test("read scans a skipped one-GiB line with fixed scratch and source allocations", async (t) => {
  await withDirectory(async (cwd) => {
    const skipped = 1_073_741_824;
    const suffix = Buffer.from("\nwanted\n");
    const allocations = [];
    const allocate = Buffer.allocUnsafe;
    t.mock.method(Buffer, "allocUnsafe", function (size) {
      allocations.push(size);
      return allocate(size);
    });
    const { result, state } = await runFake(cwd, Buffer.alloc(0), { start_line: 2, max_bytes: 7 }, {
      size: skipped + suffix.length,
      fill(buffer, offset, count, position) {
        buffer.fill(0xff, offset, offset + count);
        if (position + count > skipped) {
          const start = Math.max(position, skipped);
          suffix.copy(buffer, offset + start - position, start - skipped, start - skipped + count);
        }
      },
    });
    assert.equal(text(result), "2 │ wanted\n\n[lines 2-2; next_start_line=null; eof=true]");
    assert.equal(result.details.total_lines, 2);
    assert.equal(result.details.source_bytes, 7);
    assert.equal(state.reads.length, 16_385);
    assert.equal(state.buffers.size, 1);
    assert.equal([...state.buffers][0].length, 65_536);
    assert.ok(allocations.includes(8));
    assert.equal(allocations.filter((size) => size === 8).length, 1);
    assert.ok(allocations.every((size) => size <= 65_536));
  });
});

test("read locates late line pages across many positioned blocks", async () => {
  await withDirectory(async (cwd) => {
    const source = Buffer.from("x\n".repeat(100_000));
    const { result, state } = await runFake(cwd, source, { start_line: 99_999, max_lines: 1 });
    assert.equal(text(result), "99999 │ x\n\n[lines 99999-99999; next_start_line=100000; eof=false]");
    assert.equal(result.details.total_lines, null);
    assert.deepEqual(state.reads.map((read) => read.position), [0, 65_536, 131_072, 196_608]);
    assert.equal(state.buffers.size, 1);
  });
});

test("read selects sparse bytes above 64 MiB without reading byte zero", async () => {
  await withDirectory(async (cwd) => {
    const path = join(cwd, "source");
    await truncate(path, 67_108_865);
    const writer = await open(path, "r+");
    try { await writer.write(Buffer.from("END\n"), 0, 4, 67_108_861); }
    finally { await writer.close(); }
    const reads = [];
    let closes = 0;
    const tool = createAgentReadTool({
      async openFile(path, flags) {
        assert.equal(flags, constants.O_RDONLY | constants.O_NONBLOCK);
        const handle = await open(path, flags);
        return {
          stat: (options) => handle.stat(options),
          read(buffer, offset, length, position) {
            reads.push({ length, position });
            return handle.read(buffer, offset, length, position);
          },
          async close() { closes += 1; await handle.close(); },
        };
      },
    });
    const result = await execute(tool, { path: "source", mode: "bytes", start_byte: 67_108_861 }, cwd);
    assert.equal(text(result), "END\n\n[bytes 67108861,67108865); next_start_byte=null; eof=true]");
    assert.equal(result.details.total_bytes, 67_108_865);
    assert.equal(result.details.has_more, false);
    assert.deepEqual(reads, [{ length: 4, position: 67_108_861 }]);
    assert.equal(closes, 1);
  });
});

test("read permits safe byte offsets and rejects unsafe offsets in preparation and execution", async () => {
  await withDirectory(async (cwd) => {
    const tool = createAgentReadTool();
    const input = { path: "source", mode: "bytes", start_byte: Number.MAX_SAFE_INTEGER };
    assert.deepEqual(validateToolArguments(tool, { id: "read", name: "read", arguments: tool.prepareArguments(input) }), input);
    assert.equal((await execute(tool, input, cwd)).details.start_byte, 9);
    assert.equal(tool.parameters.properties.start_byte.maximum, Number.MAX_SAFE_INTEGER);
    const invalid = { ...input, start_byte: Number.MAX_SAFE_INTEGER + 1 };
    assert.throws(() => tool.prepareArguments(invalid));
    assert.equal((await execute(tool, invalid, cwd)).details.error.code, "INVALID_INPUT");
    const oversized = await runFake(cwd, Buffer.alloc(0), {}, { size: 9_007_199_254_740_992n });
    assert.equal(oversized.result.details.error.code, "RESOURCE_LIMIT");
    assert.equal(oversized.state.reads.length, 0);
  });
});

test("read confines UTF-8 validation to emitted lines and selected byte pages", async () => {
  await withDirectory(async (cwd) => {
    const source = Buffer.from([0x6f, 0x6b, 10, 0xff]);
    const first = (await runFake(cwd, source, { max_lines: 1 })).result;
    assert.equal(text(first), "1 │ ok\n\n[lines 1-1; next_start_line=2; eof=false]");
    assert.equal(first.details.total_lines, null);
    const excluded = (await runFake(cwd, source, { max_bytes: 3 })).result;
    assert.equal(excluded.details.ok, true);
    assert.equal(excluded.details.limited_by, "bytes");
    for (const input of [{ start_line: 2 }, { mode: "bytes", start_byte: 3 }]) {
      assert.equal((await runFake(cwd, source, input)).result.details.error.code, "INVALID_ENCODING");
    }
    const bytes = (await runFake(cwd, source, { mode: "bytes", max_bytes: 3 }, { readLimit: 6 })).result;
    assert.equal(text(bytes), "ok\n\n[bytes 0,3); next_start_byte=3; eof=false]");
    const base64 = (await runFake(cwd, source, { mode: "bytes", start_byte: 3, encoding: "base64" })).result;
    assert.equal(text(base64), "/w==\n\n[bytes 3,4); next_start_byte=null; eof=true]");
    const skipped = (await runFake(cwd, Buffer.from([0xff, 10, 0x6f, 0x6b, 10]), { start_line: 2 })).result;
    assert.equal(text(skipped), "2 │ ok\n\n[lines 2-2; next_start_line=null; eof=true]");
    const skippedBytes = (await runFake(cwd, Buffer.from([0xff, 10, 0x6f, 0x6b, 10]), { mode: "bytes", start_byte: 2 })).result;
    assert.equal(text(skippedBytes), "ok\n\n[bytes 2,5); next_start_byte=null; eof=true]");
    const laterExcluded = (await runFake(cwd, Buffer.from([0x6f, 0x6b, 10, 0xff, 0xff, 0xff, 10]), { max_bytes: 5 })).result;
    assert.equal(laterExcluded.details.ok, true);
    assert.equal(laterExcluded.details.next_start_line, 2);
  });
});

test("read validates only formatted-cap selected lines", async () => {
  await withDirectory(async (cwd) => {
    const source = Buffer.from(`${"x".repeat(19)}\n`.repeat(2_000));
    source[39_980] = 0xff;
    const { result } = await runFake(cwd, source, { max_lines: 2_000, max_bytes: 40_960 });
    assert.equal(result.details.ok, true);
    assert.equal(result.details.limited_by, "formatted_bytes");
    assert.ok(result.details.end_line < 2_000);
    assert.equal(result.details.total_lines, 2_000);
    assert.equal(result.details.has_more, true);
    assert.equal(result.details.formatted_bytes, Buffer.byteLength(text(result)));
    assert.ok(result.details.formatted_bytes <= 49_152);
    const emitted = (await runFake(cwd, source, { start_line: 2_000 })).result;
    assert.equal(emitted.details.error.code, "INVALID_ENCODING");
  });
});

test("read retains exact UTF-8, Base64, BOM, and raw byte offsets", async () => {
  await withDirectory(async (cwd) => {
    const source = Buffer.from("Aé😀B");
    const page = (await runFake(cwd, source, { mode: "bytes", start_byte: 1, max_bytes: 2 }, { readLimit: 5 })).result;
    assert.equal(text(page), "é\n\n[bytes 1,3); next_start_byte=3; eof=false]");
    assert.equal(page.details.start_byte, 1);
    assert.equal(page.details.end_byte, 3);
    assert.equal(page.details.next_start_byte, 3);
    assert.equal((await runFake(cwd, source, { mode: "bytes", start_byte: 2 })).result.details.error.code, "INVALID_BYTE_BOUNDARY");
    assert.equal((await runFake(cwd, source, { mode: "bytes", start_byte: 1, max_bytes: 1 }, { readLimit: 4 })).result.details.error.code, "BYTE_PAGE_TOO_SMALL");
    const bom = (await runFake(cwd, Buffer.from("\uFEFFx\r\n"), { mode: "bytes", max_bytes: 3 }, { readLimit: 6 })).result;
    assert.equal(text(bom), "\uFEFF\n\n[bytes 0,3); next_start_byte=3; eof=false]");
    const raw = (await runFake(cwd, Buffer.from("\uFEFFx\r\n"), { show_line_numbers: false })).result;
    assert.equal(text(raw), "\uFEFFx\r\n\n[lines 1-1; next_start_line=null; eof=true]");
    const binary = (await runFake(cwd, source, { mode: "bytes", start_byte: 2, max_bytes: 3, encoding: "base64" }, { readLimit: 3 })).result;
    assert.equal(text(binary), `${source.subarray(2, 5).toString("base64")}\n\n[bytes 2,5); next_start_byte=5; eof=false]`);
  });
});

test("read keeps valid prefixes when malformed bytes start at the byte cap", async () => {
  await withDirectory(async (cwd) => {
    for (const invalid of [0x80, 0xbf, 0xc0, 0xff, 0xf5]) {
      for (const prefix of ["A", "é", "😀"]) {
        const source = Buffer.concat([Buffer.from(prefix), Buffer.from([invalid, 0x42])]);
        const max_bytes = Buffer.byteLength(prefix);
        const { result } = await runFake(cwd, source, { mode: "bytes", max_bytes }, { readLimit: max_bytes + 3 });
        assert.equal(text(result), `${prefix}\n\n[bytes 0,${max_bytes}); next_start_byte=${max_bytes}; eof=false]`);
        assert.equal(result.details.end_byte, max_bytes);
        assert.equal(result.details.has_more, true);
        const page = decodeBytePage(source, { totalBytes: source.length, startByte: 0, maxBytes: max_bytes, encoding: "utf8" });
        assert.equal(page.content, prefix);
        assert.equal(page.end_byte, max_bytes);
        assert.equal(page.next_start_byte, max_bytes);
        const selected = (await runFake(cwd, source, { mode: "bytes", max_bytes: max_bytes + 1 }, { readLimit: max_bytes + 4 })).result;
        assert.equal(selected.details.error.code, "INVALID_ENCODING");
      }
    }
    const boundary = (await runFake(cwd, Buffer.from([0x41, 0x80, 0x42]), { mode: "bytes", start_byte: 1, max_bytes: 1 })).result;
    assert.equal(boundary.details.error.code, "INVALID_BYTE_BOUNDARY");
  });
});

test("read backs up only for complete valid code points that cross the byte cap", async () => {
  await withDirectory(async (cwd) => {
    for (const point of ["é", "€", "😀"]) {
      const width = Buffer.byteLength(point);
      const source = Buffer.from(`A${point}B`);
      for (let max_bytes = 1; max_bytes <= width + 1; max_bytes += 1) {
        const expectedEnd = max_bytes <= width ? 1 : width + 1;
        const expectedText = max_bytes <= width ? "A" : `A${point}`;
        const { result } = await runFake(cwd, source, { mode: "bytes", max_bytes }, { readLimit: max_bytes + 3 });
        assert.equal(text(result), `${expectedText}\n\n[bytes 0,${expectedEnd}); next_start_byte=${expectedEnd}; eof=false]`);
        assert.equal(result.details.end_byte, expectedEnd);
        assert.equal(result.details.has_more, true);
        if (max_bytes < width) {
          const small = (await runFake(cwd, source, { mode: "bytes", start_byte: 1, max_bytes }, { readLimit: max_bytes + 3 })).result;
          assert.equal(small.details.error.code, "BYTE_PAGE_TOO_SMALL");
        }
      }
    }
  });
});

test("read rejects malformed and EOF-truncated code points rather than zero-byte success", async () => {
  await withDirectory(async (cwd) => {
    for (const bytes of [[0xc2], [0xe2, 0x82], [0xf0, 0x90, 0x80], [0xc0, 0x80], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80]]) {
      for (const max_bytes of [1, 4]) {
        const { result } = await runFake(cwd, Buffer.from(bytes), { mode: "bytes", max_bytes }, { readLimit: max_bytes + 3 });
        assert.equal(result.details.error.code, "INVALID_ENCODING", `${bytes}; max_bytes=${max_bytes}`);
      }
    }
    const malformed = Buffer.from([65, 0xe2, 0x82, 0xff]);
    const outside = (await runFake(cwd, malformed, { mode: "bytes", max_bytes: 1 }, { readLimit: 4 })).result;
    assert.equal(text(outside), "A\n\n[bytes 0,1); next_start_byte=1; eof=false]");
    const partial = (await runFake(cwd, malformed, { mode: "bytes", max_bytes: 2 }, { readLimit: 5 })).result;
    assert.equal(partial.details.error.code, "INVALID_ENCODING");
    const selected = (await runFake(cwd, Buffer.from([65, 0xc2, 65]), { mode: "bytes", max_bytes: 2 }, { readLimit: 5 })).result;
    assert.equal(selected.details.error.code, "INVALID_ENCODING");
  });
});

test("read rejects snapshot metadata changes without publishing source text", async () => {
  await withDirectory(async (cwd) => {
    for (const field of ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) {
      for (const input of [{}, { mode: "bytes" }]) {
        const { result, state } = await runFake(cwd, Buffer.from("ok\n"), input, {
          stat: (state) => state.reads.length ? { [field]: 99n } : {},
        });
        assert.equal(text(result), "[read error: FILE_CHANGED; The file changed during read]");
        assert.equal(state.stats, 2);
        assert.equal(result.details.ok, false);
      }
    }
    for (const input of [{}, { mode: "bytes" }]) {
      const zero = await runFake(cwd, Buffer.from("ok\n"), input, { zeroRead: true });
      assert.equal(zero.result.details.error.code, "FILE_CHANGED");
      assert.equal(zero.state.reads.length, 1);
    }
  });
});

test("read gives cancellation priority and closes without another positioned read", async () => {
  await withDirectory(async (cwd) => {
    for (const reject of [false, true]) {
      const controller = new AbortController();
      const { result, state } = await runFake(cwd, Buffer.alloc(200_000, 65), { start_line: 2 }, {
        async afterRead() {
          controller.abort();
          if (reject) throw new Error("injected read failure");
        },
      }, controller.signal);
      assert.equal(text(result), "[read error: CANCELLED; Read was cancelled]");
      assert.equal(state.reads.length, 1);
      assert.equal(state.stats, 1);
    }
    const controller = new AbortController();
    const result = await runFake(cwd, Buffer.from("ok\n"), {}, {
      stat: (state) => {
        if (state.stats === 2) controller.abort();
        return { mtimeNs: 99n };
      },
    }, controller.signal);
    assert.equal(result.result.details.error.code, "CANCELLED");
    const closing = new AbortController();
    const afterClose = await runFake(cwd, Buffer.from("ok\n"), {}, { afterClose: () => closing.abort() }, closing.signal);
    assert.equal(afterClose.result.details.error.code, "CANCELLED");
  });
});

test("read handles positive short reads across lines and code points", async () => {
  await withDirectory(async (cwd) => {
    const source = Buffer.from("skip\né\n😀\r\nlast");
    for (const input of [{ start_line: 2 }, { mode: "bytes", start_byte: 5, max_bytes: 5 }, { mode: "bytes", encoding: "base64", max_bytes: 10 }]) {
      const normal = (await runFake(cwd, source, input)).result;
      const { result, state } = await runFake(cwd, source, input, { shortRead: 1 });
      assert.deepEqual(result, normal);
      assert.ok(state.reads.length > 1);
      assert.deepEqual(state.reads.map((read) => read.position), Array.from({ length: state.reads.length }, (_, i) => (input.start_byte ?? 0) + i));
    }
  });
});

test("read closes invalid text and I/O failures and maps permission errors", async () => {
  await withDirectory(async (cwd) => {
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    const tool = createAgentReadTool({ openFile: async () => { throw denied; } });
    assert.equal((await execute(tool, { path: "source" }, cwd)).details.error.code, "NOT_READABLE");
    const invalid = await runFake(cwd, Buffer.from([0xff]));
    assert.equal(invalid.result.details.error.code, "INVALID_ENCODING");
    const failed = await runFake(cwd, Buffer.from("ok"), {}, { throwRead: denied });
    assert.equal(failed.result.details.error.code, "NOT_READABLE");
    await symlink("source", join(cwd, "alias"));
    const linked = await runFake(cwd, Buffer.from("ok"), { path: "alias" }, { throwRead: denied });
    assert.equal(linked.result.details.error.path, await realpath(join(cwd, "source")));
  });
});

test("read closes handles when open-time stat fails or cancellation occurs", async () => {
  await withDirectory(async (cwd) => {
    for (const stage of ["open", "stat", "stat-error"]) {
      const controller = new AbortController();
      const fake = fakeFile(Buffer.from("ok\n"));
      const initialStat = fake.handle.stat;
      fake.handle.stat = async (options) => {
        if (stage === "stat-error") throw new Error("injected stat failure");
        if (stage === "stat") controller.abort();
        return initialStat(options);
      };
      const tool = createAgentReadTool({
        async openFile(path, flags) {
          const handle = await fake.openFile(path, flags);
          if (stage === "open") controller.abort();
          return handle;
        },
      });
      const result = await execute(tool, { path: "source" }, cwd, controller.signal);
      assert.equal(result.details.error.code, stage === "stat-error" ? "INTERNAL_ERROR" : "CANCELLED");
      assert.equal(fake.state.closes, 1);
      assert.equal(fake.state.reads.length, 0);
    }
  });
});

test("read rejects FIFO preflight without opening it", async () => {
  await withDirectory(async (cwd) => {
    const path = join(cwd, "fifo");
    execFileSync("mkfifo", [path]);
    let opens = 0;
    const tool = createAgentReadTool({ openFile: async () => { opens += 1; throw new Error("must not open"); } });
    const result = await execute(tool, { path: "fifo" }, cwd);
    assert.equal(result.details.error.code, "UNSUPPORTED_FILE_TYPE");
    assert.equal(opens, 0);
  });
});

test("read opens a FIFO replacement with O_NONBLOCK and closes its rejected handle", async () => {
  await withDirectory(async (cwd) => {
    let closes = 0;
    const tool = createAgentReadTool({
      async openFile(path, flags) {
        assert.equal(flags, constants.O_RDONLY | constants.O_NONBLOCK);
        await rm(path);
        execFileSync("mkfifo", [path]);
        const handle = await open(path, flags);
        return {
          stat: (options) => handle.stat(options),
          read() { throw new Error("must not read a FIFO"); },
          async close() { closes += 1; await handle.close(); },
        };
      },
    });
    const result = await execute(tool, { path: "source" }, cwd);
    assert.equal(result.details.error.code, "UNSUPPORTED_FILE_TYPE");
    assert.equal(closes, 1);
  });
});

test("reusable byte pages freeze a growing prefix without a whole-file metadata gate", async () => {
  const reader = fakeFile(Buffer.from("é😀APPENDED"), { readLimit: 9 });
  const page = await readBytePage(reader.handle, { totalBytes: 6, startByte: 0, maxBytes: 6, encoding: "utf8" });
  assert.equal(page.content, "é😀");
  assert.equal(page.end_byte, 6);
  assert.deepEqual(reader.state.reads, [{ offset: 0, length: 6, position: 0 }]);
  assert.equal(reader.state.stats, 0);
  assert.equal(reader.state.closes, 0);
});

test("reusable live byte decoding withholds only a valid partial trailing code point", async () => {
  for (const source of [Buffer.from([0xc2]), Buffer.from([0xe2, 0x82]), Buffer.from([0xf0, 0x90, 0x80])]) {
    for (const prefix of [Buffer.alloc(0), Buffer.from("ok")]) {
      const bytes = Buffer.concat([prefix, source]);
      const options = { totalBytes: bytes.length, startByte: 0, maxBytes: 20, encoding: "utf8" };
      assert.throws(() => decodeBytePage(bytes, options), { code: "INVALID_ENCODING" });
      const live = decodeBytePage(bytes, { ...options, allowIncompleteUtf8: true });
      assert.equal(live.content, prefix.toString());
      assert.equal(live.end_byte, prefix.length);
      assert.equal(live.next_start_byte, prefix.length);
      assert.equal(live.has_more, true);
      const reader = fakeFile(bytes);
      assert.deepEqual(await readBytePage(reader.handle, { ...options, allowIncompleteUtf8: true }), live);
    }
  }
  assert.throws(() => decodeBytePage(Buffer.from([0xe0, 0x80]), {
    totalBytes: 2, startByte: 0, maxBytes: 20, encoding: "utf8", allowIncompleteUtf8: true,
  }), { code: "INVALID_ENCODING" });
  const complete = decodeBytePage(Buffer.from("é"), { totalBytes: 2, startByte: 0, maxBytes: 20, encoding: "utf8", allowIncompleteUtf8: true });
  assert.equal(complete.end_byte, 2);
  assert.equal(complete.has_more, false);
});

test("reusable byte decoding rejects incomplete buffers and unsafe options", async () => {
  const options = { totalBytes: 10, startByte: 0, maxBytes: 4, encoding: "utf8" };
  assert.throws(() => decodeBytePage(Buffer.alloc(4), options), { code: "INVALID_INPUT" });
  assert.throws(() => decodeBytePage(Buffer.alloc(10), { ...options, startByte: Number.MAX_SAFE_INTEGER + 1 }), { code: "INVALID_INPUT" });
  assert.throws(() => decodeBytePage(Buffer.alloc(10), { ...options, encoding: "unknown" }), { code: "INVALID_INPUT" });
  const fake = fakeFile(Buffer.from("ok"));
  await assert.rejects(readBytePage(fake.handle, { ...options, encoding: "unknown" }), { code: "INVALID_INPUT" });
  assert.equal(fake.state.reads.length, 0);
});

test("read source has no whole-file read or decode path", async () => {
  const source = await readFile(new URL("../../extensions/agent-tools/read.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /readFile|loadFileBuffer|countLogicalLines|findNextLineSpan|MAX_FILE_BYTES/);
  assert.match(source, /Buffer\.allocUnsafe\(input\.maxBytes \+ 1\)/);
});
