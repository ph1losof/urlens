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

// Run all three engines concurrently — they're fully independent and the
// inner page.evaluate is the dominant cost. Collect each engine's output
// into a buffer so the printed blocks stay grouped instead of interleaving.
async function runEngine({ name, launcher }: EngineLabel): Promise<string> {
  const browser = await launcher.launch();
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto("about:blank");
    return await page.evaluate(wrapper);
  } finally {
    await browser.close();
  }
}

const settled = await Promise.allSettled(engines.map(runEngine));
for (let i = 0; i < engines.length; i++) {
  const { name } = engines[i];
  console.log(`\n======== ${name} ========`);
  const r = settled[i];
  if (r.status === "fulfilled") {
    console.log(r.value);
  } else {
    console.error(`[${name}] error:`, r.reason);
  }
}
