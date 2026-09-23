import * as assert from "assert";
import { readFileSync } from "fs";
import * as path from "path";

const root = path.resolve(__dirname, "../../..");

function readMessages(filename: string): Record<string, string> {
  const value: unknown = JSON.parse(readFileSync(path.join(root, filename), "utf8"));
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  const messages: Record<string, string> = {};
  for (const [key, message] of Object.entries(value)) {
    assert.strictEqual(typeof message, "string");
    assert.ok(typeof message === "string" && message.length > 0);
    messages[key] = message;
  }
  return messages;
}

suite("Localization manifest", () => {
  test("provides English and Chinese for every manifest label without changing welcome actions", () => {
    const manifest = readFileSync(path.join(root, "package.json"), "utf8");
    const english = readMessages("package.nls.json");
    const chinese = readMessages("package.nls.zh.json");
    const keys = [...manifest.matchAll(/%([^%"]+)%/g)].map((match) => match[1]);
    assert.ok(keys.includes("view.changes") && keys.includes("view.timeline"));
    assert.deepStrictEqual([...keys].sort(), Object.keys(english).sort());
    assert.deepStrictEqual(Object.keys(chinese).sort(), Object.keys(english).sort());
    assert.strictEqual(english["view.changes"], "AGENT CHANGES");
    assert.strictEqual(chinese["view.changes"], "智能体变更");
    assert.strictEqual(chinese["view.timeline"], "会话时间线");
    for (const key of keys) {
      assert.deepStrictEqual(
        [...chinese[key].matchAll(/command:([^)]+)/g)].map((match) => match[1]),
        [...english[key].matchAll(/command:([^)]+)/g)].map((match) => match[1]),
      );
    }
  });
});
