import { readFileSync } from "node:fs";
import { type BrowserType, chromium, firefox, webkit } from "playwright";

const benchSrc = readFileSync(new URL("./bench.js", import.meta.url), "utf8");

// The harness uses `out()` which falls back to console.log. We override it
// to collect into an array so we can return the full transcript to Node.
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
