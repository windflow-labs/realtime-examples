import { openSession, sendCamera } from "./session.js";
import { openReplay } from "./replay.js";

const $ = (id) => document.getElementById(id);
const model = $("model"), mode = $("mode"), prompt = $("prompt"), image = $("image");
const isReplay = () => mode.value === "replay";
let liveEnabled = false;
const defaults = {
  lingbot: { prompt: "A misty pine forest trail at dawn, cinematic natural light", guide: "lingbot-api", note: "Choose an image you can use, then explore with W/A/S/D and look with ←/→." },
  "sana-streaming": { prompt: "Turn the background into a hand-painted watercolor; keep the person unchanged", guide: "sana-streaming-api", note: "Your browser will ask to share your camera after the worker is ready. Camera frames leave this device during the session." },
  helios: { prompt: "A lighthouse on a sea cliff in a storm, slow push-in", guide: "helios-api", note: "Start with a prompt and an optional image. Apply a new prompt while the stream runs." },
  "longlive-v2": { prompt: "A chef chops vegetables in a quiet kitchen at dawn, medium shot", guide: "longlive-2-api", note: "Apply prompt makes a soft shot transition. Cut to new scene clears the rolling scene context." },
};
let active, stopCamera, visible = false, actionBusy = false, releasing = false, inputSequence = 0;
const held = new Set();
const keyMap = { KeyW: "forward", KeyS: "back", KeyA: "left", KeyD: "right", ArrowLeft: "look_left", ArrowRight: "look_right" };

function status(text) { $("status").textContent = text; }
function event(message) {
  const item = document.createElement("li");
  const label = message.origin === "simulation" ? "SIMULATED" : message.origin === "local" ? "LOCAL" : "LIVE";
  item.textContent = `${new Date().toLocaleTimeString()} ${label} · ${message.type}${message.command ? ` · ${message.command}` : ""}`;
  $("events").prepend(item);
  while ($("events").children.length > 40) $("events").lastChild.remove();
}
function buttons() {
  const busy = Boolean(active);
  model.disabled = busy; mode.disabled = busy; image.disabled = busy;
  $("start").disabled = busy || actionBusy || (!isReplay() && !liveEnabled);
  $("start").textContent = isReplay() ? "Play recorded sample" : "Start paid session";
  $("release").disabled = !busy || releasing;
  $("release").textContent = isReplay() ? "Stop replay" : active?.closed ? "Retry release" : "Release session";
  $("update").disabled = !busy || !visible || actionBusy;
  $("cut").disabled = !busy || !visible || actionBusy;
}
function clearKeys() {
  held.clear();
  if (active && model.value === "lingbot") active.sendInput([], ++inputSequence);
}
async function stop() {
  const run = active;
  clearKeys(); stopCamera?.(); stopCamera = undefined;
  visible = false; releasing = true; buttons();
  try {
    if (run) {
      status(isReplay() ? "Stopping local replay…" : "Releasing session…");
      const confirmed = await run.release();
      if (confirmed && active === run) active = undefined;
    }
  } finally { releasing = false; buttons(); }
}
function configure() {
  const config = defaults[model.value];
  prompt.value = config.prompt;
  $("model-note").textContent = isReplay() ? "Play the existing recorded clip. Controls demonstrate client behavior only and never change its frames; no camera is requested." : config.note;
  $("prompt-label").textContent = isReplay() ? "Simulated prompt — does not change recorded output" : "Prompt";
  $("replay-boundary").hidden = !isReplay();
  $("live-billing").hidden = isReplay();
  $("output-caption").textContent = isReplay() ? "Prerecorded output · simulated controls do not change the video" : "Live generated output · movement enables after the first painted frame";
  $("output").setAttribute("aria-label", isReplay() ? "Prerecorded model output; movement controls are simulated" : "Live generated output; focus here for world movement");
  $("control-feedback").textContent = isReplay() ? "No controls have been simulated. Focus the output for LingBot key feedback." : "Controls will be sent to the active model.";
  $("image-field").hidden = isReplay() || !["lingbot", "helios"].includes(model.value);
  $("image-note").textContent = model.value === "lingbot" ? "required" : "optional";
  $("camera-panel").hidden = isReplay() || model.value !== "sana-streaming";
  $("cut").hidden = model.value !== "longlive-v2";
  $("update").textContent = (isReplay() ? "Simulate: " : "") + (model.value === "lingbot" ? "Trigger prompt event" : model.value === "longlive-v2" ? "Apply soft shot" : "Apply prompt");
  $("cut").textContent = isReplay() ? "Simulate scene cut" : "Cut to new scene";
  $("guide").href = `https://windflow.online/guides/${config.guide}`;
  buttons();
}
model.addEventListener("change", configure);
mode.addEventListener("change", () => { configure(); status(isReplay() ? "Replay is ready. No API session has been created." : "Paid live mode selected. Starting creates a billable model session."); });
$("controls").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (active || actionBusy) return;
  const selected = model.value, replay = isReplay(), text = prompt.value.trim(), file = image.files[0];
  if (!replay && !liveEnabled) return status("Paid live mode is disabled. Start the local server with --live and your approved API key.");
  if (!text) return status("Enter a prompt.");
  if (!replay && selected === "lingbot" && !file) return status("LingBot requires a seed image.");
  if (!replay && ["lingbot", "helios"].includes(selected) && file && (file.size > 20 * 1024 * 1024 || !file.type.startsWith("image/")))
    return status("Choose an image smaller than 20 MiB.");
  actionBusy = true; visible = false; inputSequence = 0;
  $("output").getContext("2d").clearRect(0, 0, $("output").width, $("output").height);
  status(replay ? "Loading recorded output. The startup steps are simulated; Stop replay cancels them." : "Connecting. Capacity may need to start; you can cancel with Release session.");
  const run = (replay ? openReplay : openSession)(selected, $("output"), (message) => {
    if (active !== run) return;
    event(message);
    if (message.type === "input_simulated") $("control-feedback").textContent = `Simulated keys: ${message.keys.length ? message.keys.join(", ") : "none"}. Recorded movement is unchanged.`;
    if (message.type === "control_simulated") $("control-feedback").textContent = `Simulated ${message.command}. The prerecorded video is unchanged.`;
    if (message.type === "queued") status(replay ? "Simulated queue step — no model capacity was requested. Stop replay cancels startup." : `Waiting for model capacity${message.position == null ? "" : ` · position ${message.position}`}. Release cancels the queue ticket.`);
    if (message.type === "first_frame_visible") { visible = true; status(replay ? "Recorded output is playing. Controls are simulated and do not change these frames." : "Live output is visible. Release the session when finished."); buttons(); }
    if (message.type === "released") { status(replay ? "Local replay stopped. No paid session exists; you can restart or choose another model." : "Session cleanup confirmed."); visible = false; active = undefined; buttons(); }
    if (message.type === "release_pending") status(message.message);
    if (message.type === "release_unconfirmed") status(message.message);
    if (message.type === "example_error") { status(message.message); stopCamera?.(); stopCamera = undefined; }
    if (message.type === "session_ended" || message.type === "example_error") {
      visible = false;
      stopCamera?.(); stopCamera = undefined;
      // Keep the handle so the later cleanup result remains visible and
      // an unconfirmed release cannot silently unlock another paid session.
      buttons();
    }
    if (message.type === "command_error") status("The model rejected a command. Check the guide for supported controls.");
  });
  active = run; buttons();
  try {
    const hello = await run.ready;
    if (run.closed) return;
    if (replay) {
      // Playback uses a fixed recording; do not upload inputs or request a camera.
    } else if (selected === "sana-streaming") {
      await run.command("set_mode", { mode: "live" });
      status("Allow camera access to send a live source to SANA.");
      stopCamera = await sendCamera(run, hello, $("camera"));
      await run.command("set_prompt", { prompt: text });
      await run.waitFor("source_ready", 45000);
    } else if (selected === "longlive-v2") await run.command("set_shot", { prompt: text });
    else if (file) {
      const seed = await run.upload(file);
      await run.command("set_conditioning", { prompt: text, image: { id: seed.id } });
    } else await run.command("set_prompt", { prompt: text });
    if (run.closed) return;
    await run.command("start");
    if (!visible) status(replay ? "Playing a prerecorded sample. Waiting for its first painted frame…" : "Generating. Waiting for the first visible frame…");
    await run.waitFor("first_frame_visible", 60000);
  } catch (error) {
    if (active === run) await stop();
    else await run.release();
    if (run.releaseConfirmed) status(replay ? `${error.message} Replay resources were cleaned up; no API session was created.` : `${error.message} Session cleanup confirmed.`);
  } finally { actionBusy = false; buttons(); }
});
$("release").addEventListener("click", () => { void stop(); });
async function update(cut = false) {
  if (!active || !visible || actionBusy) return;
  const text = prompt.value.trim(); if (!text) return status("Enter a prompt.");
  actionBusy = true; buttons();
  try {
    if (model.value === "lingbot") await active.command("trigger_event", { eventId: crypto.randomUUID(), prompt: text });
    else await active.command(model.value === "longlive-v2" ? cut ? "scene_cut" : "set_shot" : "set_prompt", { prompt: text });
    status(isReplay() ? "Control simulated locally. The prerecorded output does not change." : "Command accepted. The visual change follows the model's generation boundary.");
  } catch (error) { status(error.message); }
  finally { actionBusy = false; buttons(); }
}
$("update").addEventListener("click", () => { void update(); });
$("cut").addEventListener("click", () => { void update(true); });
addEventListener("keydown", (e) => {
  const key = keyMap[e.code];
  if (!key || !active || !visible || model.value !== "lingbot" || e.target.closest?.("input,textarea,select,button")) return;
  e.preventDefault();
  if (!held.has(key)) { held.add(key); active.sendInput([...held], ++inputSequence); }
});
addEventListener("keyup", (e) => { if (held.delete(keyMap[e.code])) active?.sendInput([...held], ++inputSequence); });
addEventListener("blur", clearKeys);
document.addEventListener("visibilitychange", () => { if (document.hidden) clearKeys(); });
addEventListener("pagehide", () => { clearKeys(); stopCamera?.(); void active?.release(); });
configure();

// Configuration is local-only. Replay stays the default even when --live is enabled.
void fetch("/api/config").then((response) => {
  if (!response.ok) throw new Error("Local configuration is unavailable.");
  return response.json();
}).then((config) => {
  liveEnabled = config.liveEnabled === true;
  $("live-option").disabled = !liveEnabled;
  buttons();
}).catch(() => { status("Replay remains available. Paid live mode could not be verified and stays disabled."); });
