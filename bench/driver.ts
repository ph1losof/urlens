import { type BrowserType, chromium, firefox, webkit } from "playwright";

// Bundle as an IIFE because Playwright evaluates it without a module loader.
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
const benchFilter = process.env.URLENS_BENCH_FILTER ?? "";
const benchBudget = Number(process.env.URLENS_BENCH_BUDGET ?? 600);
const engineFilter = (process.env.URLENS_BENCH_ENGINE ?? "").toLowerCase();

// Capture harness output for scripts/update-readme-bench.ts.
const wrapper = `
(async () => {
  const __lines = [];
  globalThis.print = (s) => __lines.push(String(s));
  globalThis.URLENS_BENCH_FILTER = ${JSON.stringify(benchFilter)};
  globalThis.URLENS_BENCH_BUDGET = ${JSON.stringify(benchBudget)};
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

async function runEngine({ launcher }: EngineLabel): Promise<string> {
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

// Benchmark engines sequentially. Concurrent browser processes contend for
// the same CPU and make the small deltas this harness measures unreliable.
let failed = false;
for (const engine of engines) {
  const { name } = engine;
  if (engineFilter && !name.toLowerCase().includes(engineFilter)) {
    continue;
  }
  console.log(`\n======== ${name} ========`);
  try {
    console.log(await runEngine(engine));
  } catch (error) {
    failed = true;
    console.error(`[${name}] error:`, error);
  }
}
if (failed) {
  process.exitCode = 1;
}
