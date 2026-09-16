(() => {
  const isGitHubPages = window.location.hostname === "aniilogs.github.io";
  const isLocalPreview = window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost";
  const apiUrl = isGitHubPages ? "https://aniilogs-api.pages.dev/api" : `${window.location.origin}/api`;
  const contentBaseUrl = isLocalPreview
    ? "http://127.0.0.1:8788/releases/3528012"
    : "https://aniilogs-api.pages.dev/api/content/releases/3528012";
  const contentRevision = "20260916-build3528012-trait-icons-r17";
  window.ANIILOGS_CONFIG = Object.freeze({
    apiUrl,
    shareApiUrl: apiUrl,
    contentPackageVersion: 3528012,
    contentAvailable: true,
    aniilogAvailable: true,
    contentBaseUrl,
    contentRevision,
  });
})();
