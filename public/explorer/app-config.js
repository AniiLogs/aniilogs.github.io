(() => {
  const isGitHubPages = window.location.hostname === "aniilogs.github.io";
  const isLocalPreview = window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost";
  const apiUrl = isGitHubPages ? "https://aniilogs-api.pages.dev/api" : `${window.location.origin}/api`;
  const contentBaseUrl = isLocalPreview
    ? "http://127.0.0.1:8788/releases/3535596"
    : "https://aniilogs-api.pages.dev/api/content/releases/3535596";
  const contentRevision = "20261029-build3846247-whisperwake-r76";
  window.ANIILOGS_CONFIG = Object.freeze({
    apiUrl,
    shareApiUrl: apiUrl,
    // contentPackageVersion names the reviewed R2 release (releases/3535596/) and the live viewer's
    // approved package, so it stays put; gameBuild is only the game build shown to visitors.
    contentPackageVersion: 3535596,
    gameBuild: 3846247,
    contentAvailable: true,
    aniilogAvailable: true,
    contentBaseUrl,
    contentRevision,
    // Deployment gate: set only after a dedicated Pages origin serves the
    // reviewed manifest with CORS and transparent viewer HTML that allows this
    // site's iframe in frame-ancestors (without X-Frame-Options: DENY). Its
    // runtime must post the matching ready message after its first usable frame.
    liveViewerOrigin: "",
    // View Model: the 3D viewer for released Aniimo (embed mode, no sign-in).
    modelViewerOrigin: isLocalPreview
      ? "http://127.0.0.1:49574"
      : "https://aniilogs-renderer-qa-3634150.pages.dev",
  });
})();
