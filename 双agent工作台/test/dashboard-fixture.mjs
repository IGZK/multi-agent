import { chromium } from "playwright-core";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testBrowserPath } from "./browser-test-support.mjs";

// Each test owns a random local port and a fresh browser profile. API traffic is mocked by the caller.
export async function dashboardFixture(viewport = { width: 1440, height: 900 }) {
  const executablePath = testBrowserPath();
  const webDir = fileURLToPath(new URL("../web/", import.meta.url));
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
    const name = pathname === "/" ? "index.html" : pathname.slice(1);
    const file = path.resolve(webDir, name);
    if (!file.startsWith(path.resolve(webDir) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404); res.end(); return;
    }
    const type = { ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".txt": "text/plain" }[path.extname(name)] || "text/html";
    res.writeHead(200, { "Content-Type": `${type}; charset=utf-8` });
    res.end(fs.readFileSync(file));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  let browser;
  const close = async () => {
    try { await browser?.close(); }
    finally { await new Promise((resolve) => server.close(resolve)); }
  };
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({ viewport });
    return { browser, page, baseUrl: `http://127.0.0.1:${server.address().port}`, close };
  } catch (error) { await close(); throw error; }
}
