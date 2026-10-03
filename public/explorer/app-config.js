(() => {
  const isGitHubPages = window.location.hostname === "aniilogs.github.io";
  const isLocalPreview = window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost";
  const apiUrl = isGitHubPages ? "https://aniilogs-api.pages.dev/api" : `${window.location.origin}/api`;
  const contentBaseUrl = isLocalPreview
    ? "http://127.0.0.1:8788/releases/3535596"
    : "https://aniilogs-api.pages.dev/api/content/releases/3535596";
  const contentRevision = "20260929-build3535596-pawney-turntable-pilot-r64";
  window.ANIILOGS_CONFIG = Object.freeze({
    apiUrl,
    shareApiUrl: apiUrl,
    contentPackageVersion: 3535596,
    contentAvailable: true,
    aniilogAvailable: true,
    contentBaseUrl,
    contentRevision,
    // Deployment gate: set only after a dedicated Pages origin serves the
    // reviewed manifest with CORS and transparent viewer HTML that allows this
    // site's iframe in frame-ancestors (without X-Frame-Options: DENY). Its
    // runtime must post the matching ready message after its first usable frame.
    liveViewerOrigin: "",
  });
})();
