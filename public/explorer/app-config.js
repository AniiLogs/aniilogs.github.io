(() => {
  const isGitHubPages = window.location.hostname === "aniilogs.github.io";
  const isLocalPreview = window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost";
  const apiUrl = isGitHubPages ? "https://aniilogs-api.pages.dev/api" : `${window.location.origin}/api`;
  const contentBaseUrl = isLocalPreview ? "http://127.0.0.1:8788/releases/3509129" : "";
  window.ANIILOGS_CONFIG = Object.freeze({
    apiUrl,
    shareApiUrl: apiUrl,
    contentAvailable: isLocalPreview,
    aniilogAvailable: isLocalPreview,
    contentBaseUrl,
    itemDataUrl: isLocalPreview
      ? `${contentBaseUrl}/data/itemlog_data.json?v=20260914-build3509129-r2-v1`
      : "",
  });
})();
