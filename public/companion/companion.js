// The download line shows the latest release's real version and installer size (read from GitHub), so it never
// goes stale; the page's own text is the fallback.
(async () => {
  const size = document.querySelector("[data-download-size]");
  if (!size) return;
  try {
    const response = await fetch("https://api.github.com/repos/AniiLogs/aniilogs.github.io/releases/latest", { headers: { accept: "application/vnd.github+json" } });
    if (!response.ok) return;
    const release = await response.json();
    const asset = (release.assets || []).find((item) => item.name === "AniiLogs-Companion-Setup.exe");
    if (!asset?.size) return;
    const version = String(release.tag_name || "").replace(/^companion-/u, "");
    size.textContent = `${version ? `${version} · ` : ""}about ${Math.round(asset.size / 1048576)} MB`;
  } catch {
    // offline or rate-limited: the page keeps its own text
  }
})();
