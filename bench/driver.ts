import { type BrowserType, chromium, firefox, webkit } from "playwright";

// Bundle the harness (which imports the public API from ../src) as a single
// IIFE that runs in a browser page context. Bun's bundler resolves the ESM
// imports across src/ at build time; the resulting script needs no module
// system at runtime, so page.evaluate can eval it directly.
const harnessPath = new URL("./harness.ts", import.meta.url).pathname;
const build = await Bun.build({
  entrypoints: [harnessPath],
  target: "browser",
  format: "iife",
  minify: false,
});
if (!build.success) {
  for (const log of build.logs) {
    console.error(log);
  }
  throw new Error("bench harness bundle failed");
}
const benchSrc = await build.outputs[0].text();

// The harness calls `print(...)` to emit lines. We override `globalThis.print`
// before eval so each line lands in `__lines`, then return the joined text to
// Node for the parser in scripts/update-readme-bench.ts.
const wrapper = `
(async () => {
  const __lines = [];
  globalThis.print = (s) => __lines.push(String(s));
  ${benchSrc}
  return __lines.join("\\n");
})()
`;

interface EngineLabel {
  name: string;
  launcher: BrowserType;
}

const engines: EngineLabel[] = [
  { name: "Chromium (V8)", launcher: chromium },
  { name: "Firefox (SpiderMonkey)", launcher: firefox },
  { name: "WebKit (JavaScriptCore)", launcher: webkit },
];

for (const { name, launcher } of engines) {
  console.log(`\n======== ${name} ========`);
  const browser = await launcher.launch();
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto("about:blank");
    const output = await page.evaluate(wrapper);
    console.log(output);
  } catch (e) {
    console.error(`[${name}] error:`, e);
  } finally {
    await browser.close();
  }
}
