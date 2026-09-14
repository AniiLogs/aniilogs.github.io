const loginLinks = [...document.querySelectorAll("[data-login]")];
const accountButton = document.querySelector("[data-account]");
const logoutButton = document.querySelector("[data-logout]");
const status = document.querySelector("[data-auth-status]");
const isGitHubPages = window.location.hostname === "aniilogs.github.io";

function showSignedOut(message = "Sign in to sync progress and prepare your future public profile.") {
  for (const link of loginLinks) link.hidden = false;
  accountButton.hidden = true;
  logoutButton.hidden = true;
  status.textContent = message;
}

function showSignedIn(account) {
  for (const link of loginLinks) link.hidden = true;
  const name = account.displayName || account.globalName || account.username;
  accountButton.textContent = name;
  accountButton.title = `Signed in as @${account.username}`;
  accountButton.hidden = false;
  logoutButton.hidden = false;
  status.textContent = `Signed in as ${name}. Your profile is private by default.`;
}

async function refreshAccount() {
  try {
    const response = await fetch("/api/auth/me", { credentials: "same-origin" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.authenticated) showSignedIn(payload.account);
    else showSignedOut();
  } catch {
    showSignedOut("Account service is temporarily unavailable. The public tools remain accessible.");
  }
}

logoutButton.addEventListener("click", async () => {
  logoutButton.disabled = true;
  try {
    const response = await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    showSignedOut("You are signed out.");
  } catch {
    status.textContent = "Could not sign out. Please try again.";
  } finally {
    logoutButton.disabled = false;
  }
});

const authResult = new URLSearchParams(window.location.search).get("auth");
if (authResult) {
  const messages = {
    cancelled: "Discord sign-in was cancelled.",
    failed: "Discord sign-in could not be completed.",
    invalid: "Discord returned an invalid or expired sign-in request.",
    unavailable: "Discord sign-in is awaiting deployment credentials.",
  };
  status.textContent = messages[authResult] || "Discord sign-in was not completed.";
  history.replaceState({}, "", window.location.pathname);
}

if (isGitHubPages) {
  for (const link of loginLinks) {
    link.href = "#profiles";
    link.classList.add("is-disabled");
    link.setAttribute("aria-disabled", "true");
    link.textContent = "Discord sign-in soon";
  }
  status.textContent = "Account sync is coming later. The public map will remain available to everyone.";
} else {
  refreshAccount();
}
