const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (selector) => document.querySelector(selector);

function showSession(session) {
  document.body.classList.toggle("signed-in", Boolean(session));
  if (session) {
    $("#who-name").textContent = session.displayName || session.login || `uid ${session.uid}`;
  }
  $("#login").disabled = false;
}

function showLoginError(message) {
  $("#login-error").textContent = message || "";
  $("#login").disabled = false;
}

$("#login").addEventListener("click", async () => {
  $("#login").disabled = true;
  $("#login-error").textContent = "";
  try {
    await invoke("start_login");
  } catch (error) {
    showLoginError(String(error));
  }
});

$("#logout").addEventListener("click", () => invoke("logout"));

const links = document.querySelectorAll("nav a");
links.forEach((a) => a.addEventListener("click", () => {
  links.forEach((x) => x.classList.toggle("on", x === a));
  document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("on", s.id === a.dataset.screen));
}));

listen("session-changed", (event) => showSession(event.payload));
listen("login-error", (event) => showLoginError(event.payload));

invoke("current_session")
  .then((session) => showSession(session))
  .catch((error) => showLoginError(String(error)));
