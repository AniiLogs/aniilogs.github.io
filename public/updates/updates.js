// Update pages (public/updates/<build>/): their pictures come from the reviewed content release, as on the home page.
"use strict";
for (const picture of document.querySelectorAll("img[data-content-src]")) {
  const config = window.ANIILOGS_CONFIG || {};
  const base = String(config.contentBaseUrl || "").replace(/\/+$/u, "");
  if (!base) { picture.remove(); continue; }
  picture.addEventListener("error", () => picture.remove(), { once: true });
  picture.src = `${base}/${picture.dataset.contentSrc}${config.contentRevision ? `?v=${config.contentRevision}` : ""}`;
}
