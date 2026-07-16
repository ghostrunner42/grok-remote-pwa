/**
 * Best-effort "is Grok Remote installed?" helpers.
 *
 * Reality check:
 * - No browser API reliably force-opens a home-screen PWA from a normal tab.
 * - Android Chrome can open in-scope links in the installed app when the user
 *   enables “Open supported links” (manifest handle_links / capture_links).
 * - getInstalledRelatedApps() needs a supporting browser; often HTTPS-only.
 * - We also set a cookie + localStorage flag when the app runs standalone so
 *   later visits on the same origin (esp. Android) can detect prior install.
 */
(function (root) {
  const FLAG_KEY = "grokRemoteInstalledV1";
  const COOKIE = "grok_remote_pwa";
  const COOKIE_MAX_AGE = 60 * 60 * 24 * 400; // ~13 months

  function isStandalone() {
    try {
      return (
        window.matchMedia("(display-mode: standalone)").matches ||
        window.matchMedia("(display-mode: fullscreen)").matches ||
        window.matchMedia("(display-mode: minimal-ui)").matches ||
        window.navigator.standalone === true ||
        document.referrer.includes("android-app://")
      );
    } catch {
      return false;
    }
  }

  function readCookie(name) {
    try {
      const m = document.cookie.match(
        new RegExp("(?:^|; )" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=([^;]*)")
      );
      return m ? decodeURIComponent(m[1]) : "";
    } catch {
      return "";
    }
  }

  function writeCookie(name, value, maxAge) {
    try {
      document.cookie =
        name +
        "=" +
        encodeURIComponent(value) +
        "; Path=/" +
        "; Max-Age=" +
        maxAge +
        "; SameSite=Lax";
    } catch {
      /* ignore */
    }
  }

  /** Call when running as installed/standalone app. */
  function markInstalled() {
    try {
      localStorage.setItem(FLAG_KEY, "1");
    } catch {
      /* ignore */
    }
    writeCookie(COOKIE, "1", COOKIE_MAX_AGE);
  }

  function hasLocalInstallFlag() {
    try {
      if (localStorage.getItem(FLAG_KEY) === "1") return true;
    } catch {
      /* ignore */
    }
    return readCookie(COOKIE) === "1";
  }

  /**
   * @returns {Promise<{ installed: boolean, method: string, apps?: object[] }>}
   */
  async function detectInstalled() {
    if (isStandalone()) {
      markInstalled();
      return { installed: true, method: "standalone" };
    }

    // Chromium: related webapp entry in our own manifest
    if (typeof navigator.getInstalledRelatedApps === "function") {
      try {
        const apps = await navigator.getInstalledRelatedApps();
        if (Array.isArray(apps) && apps.length > 0) {
          markInstalled();
          return { installed: true, method: "related_apps", apps };
        }
      } catch {
        /* often throws on non-HTTPS / unsupported */
      }
    }

    if (hasLocalInstallFlag()) {
      return { installed: true, method: "flag" };
    }

    return { installed: false, method: "none" };
  }

  /**
   * Build app URL with pair payload for deep open.
   * @param {string} appUrl
   * @param {object|null} pair
   * @param {string} [pairB64]
   */
  function buildAppOpenUrl(appUrl, pair, pairB64) {
    const u = new URL(appUrl, location.origin);
    if (pairB64) {
      u.searchParams.set("pair", pairB64);
    } else if (pair && typeof pair === "object") {
      try {
        const json = JSON.stringify(pair);
        const b64 = btoa(unescape(encodeURIComponent(json)))
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");
        u.searchParams.set("pair", b64);
      } catch {
        /* ignore */
      }
    }
    u.searchParams.set("source", "join");
    u.searchParams.set("t", String(Date.now()));
    return u.toString();
  }

  root.GrokPwaDetect = {
    FLAG_KEY,
    isStandalone,
    markInstalled,
    hasLocalInstallFlag,
    detectInstalled,
    buildAppOpenUrl,
  };
})(typeof window !== "undefined" ? window : globalThis);
