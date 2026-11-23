(() => {
  const isLocalPreview = window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost";
  // The site (https://aniilogs.app, and the old GitHub Pages address while it forwards there) calls the API on the API's own
  // host, so Discord sign-in keeps the redirect address registered with Discord (<API>/api/auth/discord/callback).
  // A local preview (wrangler pages dev) serves the site and the API together, so it calls its own /api.
  const apiUrl = isLocalPreview ? `${window.location.origin}/api` : "https://aniilogs-api.pages.dev/api";
  const contentBaseUrl = isLocalPreview
    ? "http://127.0.0.1:8788/releases/3535596"
    : "https://aniilogs-api.pages.dev/api/content/releases/3535596";
  const contentRevision = "20261119-build3989635-r96";
  window.ANIILOGS_CONFIG = Object.freeze({
    apiUrl,
    shareApiUrl: apiUrl,
    // The address share links are copied on: the site's own domain, whose /lb/<code> the worker answers with the
    // Discord card. Empty: the API's own /<code> link.
    linkOrigin: "https://aniilogs.app",
    // contentPackageVersion names the reviewed R2 release (releases/3535596/) and the live viewer's
    // approved package, so it stays put; gameBuild is only the game build shown to visitors.
    contentPackageVersion: 3535596,
    gameBuild: 3989635,
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
