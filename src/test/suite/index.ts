import * as path from "path";
import Mocha from "mocha";

export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: "tdd", color: true });
  mocha.addFile(path.resolve(__dirname, "extension.test.js"));
  mocha.addFile(path.resolve(__dirname, "codex.test.js"));
  mocha.addFile(path.resolve(__dirname, "localization.test.js"));
  mocha.addFile(path.resolve(__dirname, "timeline.test.js"));

  await new Promise<void>((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(`${failures} extension test(s) failed.`));
      } else {
        resolve();
      }
    });
  });
}
