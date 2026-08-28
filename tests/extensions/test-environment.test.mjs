import test from "node:test";
import assert from "node:assert/strict";

test("test processes do not inherit Cursor Cloud credentials", () => {
  assert.equal(
    process.env.CURSOR_API_KEY,
    undefined,
    "npm test scripts must unset CURSOR_API_KEY before they start test processes",
  );
});
