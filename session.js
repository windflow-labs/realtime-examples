const API = "https://api.windflow.online";
const terminal = new Set(["failed", "canceled", "ended", "expired"]);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(path, jwt, body, options = {}) {
  const response = await fetch(API + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(options.keepalive ? 15000 : 30000),
    ...options,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${data.error?.code || "api_error"} (${response.status})`);
  return data;
}

/** One owner session; no dependency on a published or private SDK. */
export function openSession(model, canvas, onMessage = () => {}) {
  const context = canvas.getContext("2d");
  let current, socket, closed = false, readySettled = false;
  let opening = true, cleanupPromise, releaseConfirmed = false;
  let latestFrame, painting = false, framesPainted = 0;
  let resolveReady, rejectReady, startupTimer;
  const seen = new Map();
  const waiters = new Set();
  const cleanups = new Set();
  const releasedConnections = new Set();
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });

  function emit(message) {
    seen.set(message.type, message);
    for (const waiter of [...waiters]) {
      if (waiter.type === message.type) { clearTimeout(waiter.timer); waiters.delete(waiter); waiter.resolve(message); }
    }
    onMessage(message);
  }
  function stopWaiters(error) {
    clearTimeout(startupTimer);
    if (!readySettled) { readySettled = true; rejectReady(error); }
    for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.reject(error); }
    waiters.clear();
  }
  async function detach(session) {
    if (!session) return true;
    if (!session.session_id || !session.connection_id || !session.jwt) {
      emit({ type: "release_unconfirmed", message: `Owner cleanup credentials are incomplete for session ${session.session_id || "(unknown)"}. Do not start another session. Release it in your dashboard; retry here if credentials become available.` });
      return false;
    }
    const key = `${session.session_id}:${session.connection_id}`;
    if (releasedConnections.has(key)) return true;
    releasedConnections.add(key);
    try {
      const result = await api(`/v1/sessions/${encodeURIComponent(session.session_id)}`, session.jwt,
        { action: "detach", connection_id: session.connection_id, release: true }, { keepalive: true });
      if (result.session_released !== true) throw new Error("Release was not confirmed.");
      return true;
    } catch {
      releasedConnections.delete(key);
      emit({ type: "release_unconfirmed", message: `Release was not confirmed for session ${session.session_id}. Start stays locked. Retry release or check your dashboard.` });
      return false;
    }
  }
  function release() {
    closed = true;
    latestFrame = undefined;
    stopWaiters(new Error("Session released."));
    for (const cleanup of [...cleanups]) { try { cleanup(); } catch { /* Continue owner cleanup. */ } }
    cleanups.clear();
    socket?.close();
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      const confirmed = await detach(current);
      if (!confirmed) return false;
      if (opening) {
        emit({ type: "release_pending", message: "Waiting for an in-flight startup request before confirming cleanup. Start stays locked." });
        return false;
      }
      releaseConfirmed = true;
      emit({ type: "released", confirmed: true });
      return true;
    })().finally(() => { cleanupPromise = undefined; });
    return cleanupPromise;
  }
  async function adopt(session) {
    current = session;
    if (closed) { await release(); throw new Error("Session released."); }
    if (!session.session_id || !session.jwt) throw new Error("Incomplete session response.");
    if (!session.connection_id) throw new Error(`Session ${session.session_id} has no owner connection credential. Generation will not start; check the dashboard.`);
  }
  function fail(error) {
    if (closed) return;
    emit({ type: "example_error", message: error.message });
    void release();
  }

  // At most one JPEG decode and one replaceable pending frame. Late output
  // never grows an unbounded promise chain or keeps painting after release.
  async function paintLatest() {
    if (painting || closed) return;
    painting = true;
    try {
      while (latestFrame && !closed) {
        const bytes = latestFrame; latestFrame = undefined;
        const frame = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
        try {
          if (!closed) {
            if (canvas.width !== frame.width || canvas.height !== frame.height) {
              canvas.width = frame.width; canvas.height = frame.height;
            }
            context.drawImage(frame, 0, 0);
            if (++framesPainted === 1) emit({ type: "first_frame_visible" });
          }
        } finally { frame.close(); }
      }
    } catch { fail(new Error("JPEG playback failed.")); }
    finally { painting = false; }
  }

  (async () => {
    try {
      const tokenResponse = await fetch("/api/token", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }), signal: AbortSignal.timeout(30000),
      });
      const token = await tokenResponse.json();
      if (!tokenResponse.ok || !token.jwt) throw new Error(token.error || "Token request failed.");
      if (closed) throw new Error("Session released.");
      await adopt(await api("/v1/sessions", token.jwt, { model, transport: "ws-h264" }));
      while (current.status === "queued" && !closed) {
        emit({ type: "queued", position: current.queue_position });
        await pause(2000);
        if (closed) break;
        const poll = await api(`/v1/sessions/${encodeURIComponent(current.session_id)}`, current.jwt);
        if (closed) break;
        if (terminal.has(poll.status)) throw new Error(`Session ${poll.status}.`);
        if (poll.status !== "queued") {
          // Same session ID adopts the placement instead of spending a second slot.
          await adopt(await api("/v1/sessions", current.jwt,
            { model, session_id: current.session_id, transport: "ws-h264" }));
        } else current.queue_position = poll.queue_position;
      }
      if (closed) { await release(); return; }
      const offer = current.transport?.offers?.find((item) => item.kind === "ws-h264");
      if (!offer?.relay_path || !offer.launch_token) throw new Error("No WebSocket media offer available.");
      const url = new URL(offer.relay_path, API);
      url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
      socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";
      startupTimer = setTimeout(() => fail(new Error("Worker readiness timed out.")), 90000);
      socket.onopen = () => {
        if (closed) return socket.close();
        socket.send(JSON.stringify({ type: "authenticate", token: offer.launch_token }));
        socket.send(JSON.stringify({ type: "client_hello", codecs: ["jpeg"] }));
      };
      socket.onmessage = ({ data }) => {
        if (closed) return;
        if (typeof data !== "string") { latestFrame = data; void paintLatest(); return; }
        let message;
        try { message = JSON.parse(data); } catch { return fail(new Error("Invalid session message.")); }
        if (message.type === "worker_ready" && !readySettled) {
          readySettled = true; clearTimeout(startupTimer); resolveReady(message);
        }
        if (message.type === "failed") return fail(new Error("Worker reported a failed session."));
        emit(message);
        if (message.type === "session_ended") void release();
      };
      socket.onerror = () => fail(new Error("Media connection failed."));
      socket.onclose = ({ code }) => {
        if (!closed) fail(new Error(`Media connection closed (${code}).`));
      };
    } catch (error) {
      stopWaiters(error);
      if (!closed) emit({ type: "example_error", message: error.message });
      await release();
    } finally {
      opening = false;
      if (closed) await release();
    }
  })();
  // A caller may release before it reaches `await ready`.
  ready.catch(() => {});

  return {
    ready, release,
    get closed() { return closed; },
    get releaseConfirmed() { return releaseConfirmed; },
    get socket() { return socket; },
    addCleanup(cleanup) {
      if (closed) { cleanup(); return () => {}; }
      cleanups.add(cleanup);
      return () => { cleanups.delete(cleanup); };
    },
    waitFor(type, timeout = 30000) {
      if (closed) return Promise.reject(new Error("Session released."));
      if (seen.has(type)) return Promise.resolve(seen.get(type));
      return new Promise((resolve, reject) => {
        const waiter = { type, resolve, reject };
        waiter.timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`Waiting for ${type} timed out.`)); }, timeout);
        waiters.add(waiter);
      });
    },
    command(type, fields = {}) {
      if (closed || !current) return Promise.reject(new Error("Session is not active."));
      return api(`/v1/sessions/${encodeURIComponent(current.session_id)}/commands`, current.jwt,
        { command: { type, ...fields } });
    },
    sendInput(keys, sequence) {
      if (!closed && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({
        type: "set_input_state", input_seq: sequence, pressed_keys: keys, client_ts: Date.now(),
      }));
    },
    async upload(file) {
      if (!file || file.size > 20 * 1024 * 1024 || !file.type.startsWith("image/"))
        throw new Error("Choose an image smaller than 20 MiB.");
      if (closed || !current) throw new Error("Session is not active.");
      const intent = await api("/v1/uploads", current.jwt,
        { filename: file.name, mime: file.type, size: file.size, session_id: current.session_id });
      if (closed) throw new Error("Session released.");
      const put = await fetch(intent.upload_url, { method: "PUT", headers: intent.headers, body: file,
        signal: AbortSignal.timeout(60000) });
      if (!put.ok) throw new Error(`Image upload failed (${put.status}).`);
      if (closed) throw new Error("Session released.");
      return api(`/v1/uploads/${encodeURIComponent(intent.file_id)}/complete`, current.jwt, {});
    },
  };
}

export async function sendCamera(session, hello, video) {
  const announcedFps = Number(hello.cameraFps);
  const fps = Number.isFinite(announcedFps) && announcedFps > 0 ? Math.min(60, announcedFps) : 12.5;
  const announcedWidth = Number(hello.cameraMaxWidth);
  const maxWidth = Number.isFinite(announcedWidth) && announcedWidth >= 2 ? Math.min(1280, announcedWidth) : 1280;
  const media = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  let timer, stopped = false, busy = false;
  let unregister = () => {};
  const stop = () => {
    if (stopped) return;
    stopped = true; clearInterval(timer);
    unregister();
    media.getTracks().forEach((track) => track.stop());
    video.pause(); video.srcObject = null;
  };
  // Register before play(): playback can wait while the tab is backgrounded.
  // A release must stop acquired camera tracks even before this function resolves.
  unregister = session.addCleanup(stop);
  if (session.closed) { stop(); throw new Error("Session released while requesting camera access."); }
  try {
    video.srcObject = media; await video.play();
    if (session.closed) { stop(); throw new Error("Session released."); }
    const capture = document.createElement("canvas");
    const scale = Math.min(1, maxWidth / video.videoWidth);
    capture.width = Math.max(2, Math.round(video.videoWidth * scale / 2) * 2);
    capture.height = Math.max(2, Math.round(video.videoHeight * scale / 2) * 2);
    const context = capture.getContext("2d");
    timer = setInterval(() => {
      const ws = session.socket;
      if (stopped || session.closed) return stop();
      if (busy || document.hidden || !video.videoWidth || ws?.readyState !== WebSocket.OPEN || ws.bufferedAmount > 1024 * 1024) return;
      busy = true;
      try {
        context.drawImage(video, 0, 0, capture.width, capture.height);
        capture.toBlob(async (blob) => {
          try {
            if (!blob || stopped || session.closed) return;
            const bytes = await blob.arrayBuffer();
            if (!stopped && !session.closed && ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 1024 * 1024) ws.send(bytes);
          } catch { stop(); void session.release(); }
          finally { busy = false; }
        }, "image/jpeg", 0.85);
      } catch { busy = false; stop(); void session.release(); }
    }, 1000 / fps);
    return stop;
  } catch (error) { stop(); throw error; }
}
