import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("V3/V4 产物无行尾空白且只有一个末尾换行", () => {
  const build = spawnSync(process.execPath, [join(ROOT, "scripts/build-workflows.mjs"), "--only", "candidate-build-v4,wave-executor-v3"], { encoding: "utf8" });
  assert.equal(build.status, 0, build.stderr);
  for (const rel of ["wave-executor-v3.dwf.ts", "candidate-build-v4.dwf.ts", "pi/wave-executor-v3.js", "pi/candidate-build-v4.js"]) {
    const text = readFileSync(join(ROOT, "skills/self/dev-workflow/workflows", rel), "utf8");
    assert.doesNotMatch(text, /[ \t]\n/, `${rel} 不应有行尾空白`);
    assert.match(text, /[^\n]\n$/, `${rel} 应恰好以单个换行结束`);
  }
});
