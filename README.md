# Windflow browser API examples

Four examples using standard `fetch`, WebSocket, canvas and a small local Node server. No npm packages, bundler, framework or private SDK is required.

| Model | API ID | What this example shows | Official model |
| --- | --- | --- | --- |
| LingBot-World | `lingbot` | Seed image, prompt, ordered WASD/look snapshots and prompt events | [Robbyant](https://github.com/Robbyant/lingbot-world) |
| SANA-Streaming | `sana-streaming` | Webcam editing, negotiated capture rate and backpressure | [NVlabs/Sana](https://github.com/NVlabs/Sana) |
| Helios | `helios` | Continuous generation and live prompt updates | [PKU-YuanGroup/Helios](https://github.com/PKU-YuanGroup/Helios) |
| LongLive 2.0 | `longlive-v2` | Soft shot transitions and hard scene cuts | [NVlabs/LongLive](https://github.com/NVlabs/LongLive) |

The upstream teams created the models; Windflow provides the hosted session integration in this example. These examples use Windflow's current catalog API IDs, which need not match upstream repository names or the public website slugs. Consult the model endpoint/guide for the exact served version. Licensing of this example does not grant rights to model weights or user content.

## Run locally

Prerequisites: Node.js 22 or newer, a modern browser supporting `createImageBitmap` and WebSocket, an approved Windflow beta account, an API key and sufficient account balance. Camera editing requires a camera and permission. `http://127.0.0.1` is a browser secure-context exception for local camera use.

1. Copy `.env.example` to `.env.local` and put your own key there. The key stays on your server; do not commit or share the file.
2. Run `node --env-file=.env.local server.mjs` from this directory.
3. Open the printed address: `http://127.0.0.1:8788`.
4. Select a model, enter a prompt and, for LingBot, choose a seed image. Click **Start paid session**.
5. LingBot: use W/A/S/D to move, left/right arrows to look. Input is enabled after a real frame is painted. SANA: approve camera access after the model is ready. Helios: change the prompt during generation. LongLive: apply a soft shot or cut to a new scene.
6. Click **Release session** when finished and check for release confirmation. Check your dashboard if cleanup is unconfirmed.

Private beta access and capacity are separate. A public model page does not promise immediate capacity. Sessions may queue while capacity is started. The UI polls the queue ticket and releases it on cancellation. The same session ID is adopted when capacity becomes available.

## Billing and access

Every browser token is model-bound, can create at most one session and requests a maximum session duration of 180 seconds. The platform may enforce a shorter model limit. Queueing and startup are free; billing starts when generation starts and continues until release or session end. Pausing or closing the player is not a billing stop. See [current prices](https://windflow.online/pricing) and [billing explanation](https://windflow.online/guides/how-per-second-pricing-works).

This is a single-user local example, served only on `127.0.0.1`. The token route enforces the exact local origin, a fixed model allowlist and bounded tokens. Before hosting it for others, add your application's authentication, per-user authorization, token-rate and spend controls, HTTPS and explicit session lifecycle monitoring. Each new token can create another paid session; the one-session token limit is not an account-wide spend limit.

## Files and protocol

- `server.mjs` serves a fixed set of local files and mints bounded browser tokens. The account API key never enters the browser bundle or logs.
- `session.js` creates/adopts a session using `transport: "ws-h264"`, authenticates with the launch token as the first socket message, then requests JPEG with `client_hello`. It uses REST for commands/uploads and the same socket for ordered input and camera JPEGs.
- JPEG output uses one active decode and one replaceable pending frame so a slow client does not build an unbounded playback queue. This intentionally favors fresh output over rendering every frame.
- SANA uses `worker_ready.cameraFps` and `cameraMaxWidth`, a fixed capture size, one in-flight JPEG conversion and a 1 MiB socket backpressure threshold. Late capture ticks are skipped, not queued. Camera tracks stop on release, pagehide or failure. This JPEG path is an educational integration, not a performance comparison with the production H.264 client.
- Release uses owner `detach` with `release: true`, including queued sessions. Late creation/adoption responses after cancellation are released when they arrive. Browser unload cleanup is best effort: a killed browser/network failure can prevent the request from arriving. The bounded session duration is an additional limit, not a guarantee that a pagehide request succeeded.
- Start stays locked until cleanup is confirmed, including when a startup request is still in flight. An unconfirmed release keeps a **Retry release** button and identifies the affected session. If the control plane returns no owner connection credential, generation is blocked and the session must be checked/released in the dashboard; the example does not silently attach a guest connection and pretend it can release the owner. After dashboard cleanup, reload the local page only after verifying that no session remains.
- No reconnect/adoption recovery after an unexpected socket failure is attempted. Release the failed session before starting another. See the [recovery guide](https://windflow.online/guides/recover-a-dropped-realtime-video-stream).

## Verification status

Prepared November 9, 2026 from the public integration guides and corresponding control-plane implementation. The token limits, queue adoption, owner release and model command names were inspected against current source. This snapshot has **not been exercised against a paid live model session**. No inference benchmark, first-frame result or latency claim is made. Runtime playback, camera permission, network cleanup and exact current deployment behavior still need a live walkthrough with an approved account. No test suite or build was run, following the source repository's agent instructions.

Useful diagnostic errors: `401` means invalid/expired credentials; `402` means insufficient balance; `403` can indicate a token-model mismatch; `429` requires honoring the service's `Retry-After` before starting again. A failed upload or denied camera permission releases the owner session. The UI shows event types and safe error codes, never raw JWTs, launch tokens or signed upload URLs.

## Guides

- [LingBot API](https://windflow.online/guides/lingbot-api)
- [SANA-Streaming API](https://windflow.online/guides/sana-streaming-api)
- [Helios API](https://windflow.online/guides/helios-api)
- [LongLive 2.0 API](https://windflow.online/guides/longlive-2-api)
- [Realtime video API](https://windflow.online/guides/realtime-video-api)

MIT license for this example code. Model and dependency licenses remain with their authors.
