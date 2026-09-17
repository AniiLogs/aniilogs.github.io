(() => {
  const isGitHubPages = window.location.hostname === "aniilogs.github.io";
  const isLocalPreview = window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost";
  const apiUrl = isGitHubPages ? "https://aniilogs-api.pages.dev/api" : `${window.location.origin}/api`;
  const contentBaseUrl = isLocalPreview
    ? "http://127.0.0.1:8788/releases/3535596"
    : "https://aniilogs-api.pages.dev/api/content/releases/3535596";
  const contentRevision = "20260917-build3535596-held-metadata-lumin-r4";
  window.ANIILOGS_CONFIG = Object.freeze({
    apiUrl,
    shareApiUrl: apiUrl,
    contentPackageVersion: 3535596,
    contentAvailable: true,
    aniilogAvailable: true,
    contentBaseUrl,
    contentRevision,
  });
})();
