import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const host = "127.0.0.1";
const port = Number(process.env.PORT || 8788);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("PORT must be 1024–65535.");
const origin = `http://${host}:${port}`;
const models = new Set(["lingbot", "sana-streaming", "helios", "longlive-v2"]);
const files = new Map([
  ["/", ["index.html", "text/html"]],
  ["/app.js", ["app.js", "text/javascript"]],
  ["/session.js", ["session.js", "text/javascript"]],
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
    if (path === "/api/token") {
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
server.listen(port, host, () => console.log(`Windflow examples: ${origin}`));
