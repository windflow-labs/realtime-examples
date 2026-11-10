import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const host = "127.0.0.1";
const port = Number(process.env.PORT || 8788);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("PORT must be 1024–65535.");
const origin = `http://${host}:${port}`;
if (process.argv.slice(2).some((arg) => arg !== "--live")) throw new Error("Use server.mjs for replay or server.mjs --live to enable paid sessions.");
const liveEnabled = process.argv.includes("--live");
if (liveEnabled && !process.env.WINDFLOW_API_KEY) throw new Error("--live requires WINDFLOW_API_KEY on the local server.");
const models = new Set(["lingbot", "sana-streaming", "helios", "longlive-v2"]);
const samples = JSON.parse(await readFile(new URL("./replay-samples.json", import.meta.url), "utf8"));
const files = new Map([
  ["/", ["index.html", "text/html"]],
  ["/app.js", ["app.js", "text/javascript"]],
  ["/session.js", ["session.js", "text/javascript"]],
  ["/replay.js", ["replay.js", "text/javascript"]],
  ["/replay-samples.json", ["replay-samples.json", "application/json"]],
  ["/style.css", ["style.css", "text/css"]],
]);

const server = createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  const json = (status, data) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data));
  };
  if (req.headers.host !== `${host}:${port}`) return json(403, { error: "Use the printed 127.0.0.1 address." });
  try {
    const path = new URL(req.url, origin).pathname;
    if (path === "/api/config" && req.method === "GET") return json(200, { liveEnabled });
    const mediaMatch = /^\/replay-media\/([a-z0-9-]+)\.webm$/.exec(path);
    if (mediaMatch && ["GET", "HEAD"].includes(req.method)) {
      const sample = samples[mediaMatch[1]];
      if (!sample || !/^media\/[a-z0-9-]+\.webm$/.test(sample.file)) return json(404, { error: "Unknown recorded sample." });
      const source = new URL(sample.source);
      if (source.origin !== "https://media.windflow.online" || !source.pathname.startsWith("/public/site/")) throw new Error("Invalid replay source.");
      const local = new URL(sample.file, import.meta.url);
      let info;
      try { info = await stat(local); } catch (error) { if (error.code !== "ENOENT") throw error; }
      const range = req.headers.range;
      if (range && !/^bytes=\d+-\d*$/.test(range)) return json(416, { error: "A single forward byte range is required." });
      res.setHeader("Cache-Control", "public, max-age=300");
      if (info) {
        if (!info.isFile() || info.size !== sample.bytes) throw new Error("Local replay sample is incomplete; download it again.");
        const match = range && /^bytes=(\d+)-(\d*)$/.exec(range);
        const start = match ? Number(match[1]) : 0;
        const end = match?.[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) {
          res.setHeader("Content-Range", `bytes */${info.size}`);
          return json(416, { error: "Byte range is outside the recorded sample." });
        }
        res.writeHead(match ? 206 : 200, {
          "Content-Type": sample.content_type, "Content-Length": end - start + 1,
          "Accept-Ranges": "bytes", "X-Replay-Source": "local",
          ...(match ? { "Content-Range": `bytes ${start}-${end}/${info.size}` } : {}),
        });
        if (req.method === "HEAD") return res.end();
        await pipeline(createReadStream(local, { start, end }), res);
      } else {
        const abort = new AbortController();
        res.on("close", () => abort.abort());
        const upstream = await fetch(source, {
          method: req.method, headers: range ? { Range: range } : {},
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30000)]), redirect: "error",
        });
        if (![200, 206].includes(upstream.status)) throw new Error("Recorded sample is unavailable.");
        res.writeHead(upstream.status, {
          "Content-Type": sample.content_type, "Accept-Ranges": "bytes", "X-Replay-Source": "public-recording",
          ...Object.fromEntries(["content-length", "content-range"].filter((header) => upstream.headers.has(header)).map((header) => [header, upstream.headers.get(header)])),
        });
        if (req.method === "HEAD") return res.end();
        if (!upstream.body) throw new Error("Recorded sample has no body.");
        await pipeline(Readable.fromWeb(upstream.body), res);
      }
      return;
    }
    if (path === "/api/token") {
      if (!liveEnabled) return json(409, { error: "Paid live mode is disabled. Replay needs no API key. Start the server with --live to enable live sessions." });
      if (req.method !== "POST") return json(405, { error: "POST required." });
      if (req.headers.origin !== origin || req.headers["content-type"]?.split(";")[0] !== "application/json")
        return json(403, { error: "Same-origin JSON request required." });
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 2048) return json(413, { error: "Request too large." });
      }
      let data;
      try { data = JSON.parse(body); } catch { return json(400, { error: "Invalid JSON." }); }
      if (!models.has(data.model)) return json(400, { error: "Unsupported example model." });
      if (!process.env.WINDFLOW_API_KEY) return json(503, { error: "Set WINDFLOW_API_KEY on the local server." });
      const response = await fetch("https://api.windflow.online/v1/tokens", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.WINDFLOW_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: data.model, max_sessions: 1, max_session_duration_seconds: 180 }),
        signal: AbortSignal.timeout(20000),
      });
      const result = await response.json();
      if (!response.ok || typeof result.jwt !== "string") {
        return json(response.ok ? 502 : response.status, { error: result.error?.code || "token_request_failed" });
      }
      return json(200, { jwt: result.jwt, expires_at: result.expires_at });
    }
    const file = files.get(path);
    if (req.method !== "GET" || !file) return json(404, { error: "Not found." });
    res.writeHead(200, { "Content-Type": `${file[1]}; charset=utf-8` });
    res.end(await readFile(new URL(file[0], import.meta.url)));
  } catch {
    if (!res.headersSent) json(502, { error: "Request failed. Check local connectivity and API access." });
    else res.end();
  }
});
server.listen(port, host, () => console.log(`Windflow examples: ${origin}\n${liveEnabled ? "Paid live mode enabled; replay remains the browser default." : "Replay mode; paid API calls are disabled. No API key is needed."}`));
