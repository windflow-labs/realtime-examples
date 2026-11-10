/** Prerecorded output with explicitly simulated controls. No inference, key or camera access. */
export function openReplay(model, canvas, onMessage = () => {}) {
  const context = canvas.getContext("2d");
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";
  const controller = new AbortController();
  const timers = new Set(), waiters = new Set(), seen = new Map();
  let closed = false, readySettled = false, started = false, painted = false;
  let animation, resolveReady, rejectReady, resolveStarted, rejectStarted, startupTimer, failure;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const firstPaint = new Promise((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
  ready.catch(() => {});
  firstPaint.catch(() => {});

  function emit(type, fields = {}, origin = "simulation") {
    if (closed && type !== "released") return;
    const message = { type, origin, simulated: origin === "simulation", ...fields };
    seen.set(type, message);
    for (const waiter of [...waiters]) if (waiter.type === type) {
      clearTimeout(waiter.timer); waiters.delete(waiter); waiter.resolve(message);
    }
    onMessage(message);
  }
  function delay(callback, ms) {
    const timer = setTimeout(() => { timers.delete(timer); if (!closed) callback(); }, ms);
    timers.add(timer);
  }
  function stopFrames() {
    cancelAnimationFrame(animation);
  }
  function release() {
    if (closed) return Promise.resolve(true);
    closed = true;
    controller.abort();
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    stopFrames();
    video.pause(); video.removeAttribute("src"); video.load();
    const error = failure ?? new Error("Replay stopped. No paid session exists.");
    if (!readySettled) { readySettled = true; rejectReady(error); }
    rejectStarted(error);
    for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.reject(error); }
    waiters.clear();
    emit("released", { confirmed: true, message: "Local replay stopped; media requests, timers and pending work canceled. No API release request was needed." }, "local");
    return Promise.resolve(true);
  }
  function fail(message) {
    if (closed) return;
    failure = new Error(message);
    emit("example_error", { message }, "local");
    void release();
  }
  function draw() {
    if (closed || video.paused || video.ended) return;
    try {
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth) {
        if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
          canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        }
        context.drawImage(video, 0, 0);
        if (!painted) {
          painted = true;
          clearTimeout(startupTimer); timers.delete(startupTimer);
          resolveStarted();
          emit("first_frame_visible", { recorded: true }, "local");
        }
      }
    } catch { return fail("Recorded video could not be painted. No inference request was sent."); }
    animation = requestAnimationFrame(draw);
  }
  // One deadline includes metadata, play() and the first painted frame. A
  // browser may leave play() pending, so it must not gate our cancellation.
  startupTimer = setTimeout(() => fail("Recorded playback startup timed out before its first painted frame (60 seconds). No inference request was sent."), 60000);
  timers.add(startupTimer);
  video.addEventListener("error", () => fail("The recorded sample could not load. Download it once with fetch-replays.mjs for offline playback, or check the media connection."), { signal: controller.signal });
  video.addEventListener("ended", () => {
    emit("session_ended", { message: "The prerecorded clip ended; this is not a model session ending." }, "local");
    void release();
  }, { signal: controller.signal });

  (async () => {
    try {
      const response = await fetch("/replay-samples.json", { signal: controller.signal });
      if (!response.ok) throw new Error("Replay sample metadata is unavailable.");
      const sample = (await response.json())[model];
      if (!sample) throw new Error("No recorded sample is available for this example model.");
      if (closed) return;
      video.src = `/replay-media/${encodeURIComponent(model)}.webm`;
      emit("queued", { position: 1, message: "Demonstration queue only; no capacity was requested and this delay is not measured." });
      delay(() => {
        const hello = { type: "worker_ready", origin: "simulation", simulated: true, message: "Local lifecycle simulation is ready; no worker connected." };
        readySettled = true; resolveReady(hello);
        emit("worker_ready", { message: hello.message });
      }, 500);
    } catch (error) { if (!closed) fail(error.message); }
  })();

  return {
    ready, release,
    get closed() { return closed; },
    get releaseConfirmed() { return closed; },
    waitFor(type, timeout = 30000) {
      if (closed) return Promise.reject(new Error("Replay stopped."));
      if (seen.has(type)) return Promise.resolve(seen.get(type));
      return new Promise((resolve, reject) => {
        const waiter = { type, resolve, reject };
        waiter.timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`Recorded playback waiting for ${type} timed out.`)); }, timeout);
        waiters.add(waiter);
      });
    },
    async command(type) {
      if (closed) throw new Error("Replay stopped.");
      if (type === "start") {
        if (!readySettled) throw new Error("Replay is not ready.");
        if (started) throw new Error("Replay already started; stop it before restarting.");
        started = true;
        emit("generation_started", { message: "Simulated lifecycle event only. The following video was recorded earlier." });
        void Promise.resolve().then(() => video.play()).then(() => {
          if (!closed) draw();
        }).catch(() => fail("Recorded playback could not start. Check browser playback support or download the sample for offline use. No inference request was sent."));
        await firstPaint;
        return { simulated: true };
      }
      const allowed = model === "lingbot" ? ["trigger_event"] : model === "longlive-v2" ? ["set_shot", "scene_cut"] : ["set_prompt"];
      if (!painted || !allowed.includes(type)) throw new Error("This replay control is unavailable before a recorded frame is visible.");
      emit("control_simulated", { command: type, message: "Control was logged locally and does not alter the prerecorded video." });
      return { simulated: true, changesRecordedContent: false };
    },
    sendInput(keys, sequence) {
      if (!closed && painted && model === "lingbot")
        emit("input_simulated", { keys, sequence, message: "Keys are local feedback only; recorded camera motion does not follow them." });
    },
  };
}
