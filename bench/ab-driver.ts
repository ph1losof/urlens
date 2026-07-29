import { join, resolve } from "node:path";
import { chromium, firefox, webkit } from "playwright";

const baselineRoot = process.env.URLENS_BENCH_BASELINE;
if (!baselineRoot) {
  throw new Error("Set URLENS_BENCH_BASELINE to a baseline checkout");
}
const candidateRoot = process.env.URLENS_BENCH_CANDIDATE;

const entrypoint = join(import.meta.dir, "ab-harness.ts");
const baselineEntry = join(resolve(baselineRoot), "src/index.ts");
const candidateEntry = candidateRoot
  ? join(resolve(candidateRoot), "src/index.ts")
  : join(import.meta.dir, "../src/index.ts");

async function sourceAdapter(source: string): Promise<string> {
  const entrySource = await Bun.file(source).text();
  const originExport = entrySource.includes("rawOriginsEqual")
    ? "rawOriginsEqual"
    : "originMatches";
  return `
    export {
      hasQueryParam,
      queryParamEquals,
      ${originExport} as rawOriginsEqual,
      readPathname,
      readPort,
      readQueryParam,
      readQueryParams,
      setPathname,
      setScheme,
      view,
    } from ${JSON.stringify(source)};
  `;
}

async function buildHarness(invert: boolean): Promise<string> {
  const baselineSource = invert ? candidateEntry : baselineEntry;
  const candidateSource = invert ? baselineEntry : candidateEntry;
  const build = await Bun.build({
    entrypoints: [entrypoint],
    target: "browser",
    format: "iife",
    minify: false,
    plugins: [
      {
        name: "paired-sources",
        setup(builder) {
          builder.onResolve({ filter: /^urlens-baseline$/ }, () => ({
            path: "baseline",
            namespace: "paired-source",
          }));
          builder.onResolve({ filter: /^urlens-candidate$/ }, () => ({
            path: "candidate",
            namespace: "paired-source",
          }));
          builder.onLoad(
            { filter: /.*/, namespace: "paired-source" },
            async (args) => ({
              contents: await sourceAdapter(
                args.path === "baseline" ? baselineSource : candidateSource
              ),
              loader: "ts",
            })
          );
        },
      },
    ],
  });
  if (!build.success) {
    for (const log of build.logs) {
      console.error(log);
    }
    process.exit(1);
  }
  return build.outputs[0].text();
}

const normalSource = await buildHarness(false);
const invertedSource = await buildHarness(true);
const budget = Number(process.env.URLENS_BENCH_BUDGET ?? 300);
const rounds = Number(process.env.URLENS_BENCH_ROUNDS ?? 7);
const filter = process.env.URLENS_BENCH_FILTER ?? "";
const engineFilter = (process.env.URLENS_BENCH_ENGINE ?? "").toLowerCase();
const engines = [
  { name: "Chromium (V8)", launcher: chromium },
  { name: "Firefox (SpiderMonkey)", launcher: firefox },
  { name: "WebKit (JavaScriptCore)", launcher: webkit },
];

interface AbResult {
  baseline: number;
  candidate: number;
  name: string;
  ratio: number;
}

async function runOrder(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  source: string,
  invert: boolean
): Promise<AbResult[]> {
  const page = await browser.newPage();
  try {
    await page.goto("about:blank");
    await page.evaluate(
      ({ benchBudget, benchFilter, benchInvert, benchRounds }) => {
        Object.assign(globalThis, {
          URLENS_BENCH_BUDGET: benchBudget,
          URLENS_BENCH_FILTER: benchFilter,
          URLENS_BENCH_INVERT: benchInvert,
          URLENS_BENCH_ROUNDS: benchRounds,
          URLENS_BENCH_SILENT: true,
        });
      },
      {
        benchBudget: budget,
        benchFilter: filter,
        benchInvert: invert,
        benchRounds: rounds,
      }
    );
    await page.addScriptTag({ content: source });
    return await page.evaluate(
      () =>
        (
          globalThis as typeof globalThis & {
            URLENS_AB_RESULTS: AbResult[];
          }
        ).URLENS_AB_RESULTS
    );
  } finally {
    await page.close();
  }
}

function formatRate(value: number): string {
  return `${(value / 1_000_000).toFixed(2)}M/s`;
}

function pad(value: string, width: number): string {
  return value.padEnd(width);
}

for (const engine of engines) {
  if (engineFilter && !engine.name.toLowerCase().includes(engineFilter)) {
    continue;
  }
  console.log(`\n======== ${engine.name} ========`);
  const browser = await engine.launcher.launch();
  try {
    const normal = await runOrder(browser, normalSource, false);
    const inverted = await runOrder(browser, invertedSource, true);
    console.log(`budget=${budget}ms rounds=${rounds} per ordering`);
    console.log(
      `${pad("case", 28)}${pad("baseline", 13)}${pad("candidate", 13)}delta (orders)`
    );
    for (let i = 0; i < normal.length; i++) {
      const first = normal[i];
      const second = inverted[i];
      if (first.name !== second.name) {
        throw new Error("A/B order result mismatch");
      }
      const baselineRate = Math.sqrt(first.baseline * second.baseline);
      const candidateRate = Math.sqrt(first.candidate * second.candidate);
      const ratio = Math.sqrt(first.ratio * second.ratio);
      const firstDelta = (first.ratio - 1) * 100;
      const secondDelta = (second.ratio - 1) * 100;
      console.log(
        `${pad(first.name, 28)}${pad(formatRate(baselineRate), 13)}${pad(
          formatRate(candidateRate),
          13
        )}${ratio >= 1 ? "+" : ""}${((ratio - 1) * 100).toFixed(2)}% (${firstDelta.toFixed(1)}%, ${secondDelta.toFixed(1)}%)`
      );
    }
  } finally {
    await browser.close();
  }
}
