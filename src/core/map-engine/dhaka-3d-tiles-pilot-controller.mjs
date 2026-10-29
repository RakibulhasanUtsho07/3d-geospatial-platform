export const DHAKA_3D_TILES_PILOT_URL = "/experimental/dhaka-3d-tiles-fixture/tileset.json";

export function isDhaka3DTilesPilotEnabled(value) {
  return value === "true";
}

function isDestroyed(value) {
  try {
    return typeof value?.isDestroyed === "function" && value.isDestroyed();
  } catch {
    return true;
  }
}

function destroyUnattachedTileset(tileset) {
  if (!tileset || isDestroyed(tileset)) return;
  try {
    if (typeof tileset.destroy === "function") tileset.destroy();
  } catch {
    // Teardown is best-effort for an asset whose async load finished after viewer shutdown.
  }
}

function resolveWorldCenter(Cesium, tileset) {
  const center = tileset?.boundingSphere?.center ?? tileset?.root?.boundingSphere?.center;
  if (!center || typeof Cesium?.Cartographic?.fromCartesian !== "function") return null;
  try {
    const cartographic = Cesium.Cartographic.fromCartesian(center);
    if (!cartographic) return null;
    const toDegrees = Cesium.Math?.toDegrees ?? ((radians) => radians * 180 / Math.PI);
    return {
      longitudeDegrees: toDegrees(cartographic.longitude),
      latitudeDegrees: toDegrees(cartographic.latitude),
      ellipsoidHeightMeters: cartographic.height,
    };
  } catch {
    return null;
  }
}

function normalizeUrl(value, name, { optional = false } = {}) {
  if (optional && value == null) return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(name + " must be a non-empty string.");
  }
  return value.trim();
}

function normalizeAttempts(value) {
  if (!Number.isInteger(value) || value < 1 || value > 3) {
    throw new RangeError("maxAttemptsPerUrl must be an integer between 1 and 3.");
  }
  return value;
}

function normalizeRetryDelay(value) {
  if (!Number.isFinite(value) || value < 0 || value > 5000) {
    throw new RangeError("retryDelayMs must be between 0 and 5000 milliseconds.");
  }
  return value;
}

function wait(milliseconds) {
  return milliseconds > 0
    ? new Promise((resolve) => setTimeout(resolve, milliseconds))
    : Promise.resolve();
}

/**
 * Owns an opt-in experimental OGC 3D Tiles primitive lifecycle.
 *
 * Cesium's fromUrl promise is not abortable through the public API used here.
 * Each load is guarded by a generation counter; disable/destroy or switching URL
 * invalidates the generation, and any late successful result is destroyed before
 * it can attach to an obsolete or disabled viewer.
 *
 * Optional fallback URLs and bounded retries are explicit constructor settings.
 * No fallback is enabled by default, so a fixture can never silently replace a
 * requested production candidate unless a caller deliberately configures it.
 */
export class Dhaka3DTilesPilotController {
  #getViewer;
  #getCesium;
  #isEnabled;
  #onStatus;
  #url;
  #fallbackUrl;
  #maxAttemptsPerUrl;
  #retryDelayMs;
  #revision = 0;
  #loading = false;
  #tileset = null;
  #attachedViewer = null;
  #attachedUrl = null;
  #inflight = null;
  #disposed = false;

  constructor({
    getViewer,
    getCesium,
    isEnabled,
    onStatus = (event) => { void event; },
    url = DHAKA_3D_TILES_PILOT_URL,
    fallbackUrl = null,
    maxAttemptsPerUrl = 2,
    retryDelayMs = 250,
  }) {
    if (typeof getViewer !== "function" || typeof getCesium !== "function" || typeof isEnabled !== "function") {
      throw new TypeError("Dhaka3DTilesPilotController requires viewer, Cesium and feature-flag providers.");
    }
    this.#getViewer = getViewer;
    this.#getCesium = getCesium;
    this.#isEnabled = isEnabled;
    this.#onStatus = onStatus;
    this.#url = normalizeUrl(url, "url");
    this.#fallbackUrl = normalizeUrl(fallbackUrl, "fallbackUrl", { optional: true });
    this.#maxAttemptsPerUrl = normalizeAttempts(maxAttemptsPerUrl);
    this.#retryDelayMs = normalizeRetryDelay(retryDelayMs);
  }

  #emit(status, details = {}) {
    try {
      this.#onStatus?.({ status, url: this.#url, ...details });
    } catch {
      // Observability callbacks must not break map lifecycle.
    }
  }

  #isCurrent(revision, viewer) {
    try {
      return !this.#disposed &&
        revision === this.#revision &&
        this.#isEnabled() &&
        this.#getViewer() === viewer &&
        !isDestroyed(viewer);
    } catch {
      return false;
    }
  }

  #detachAttached() {
    const tileset = this.#tileset;
    const viewer = this.#attachedViewer;
    this.#tileset = null;
    this.#attachedViewer = null;
    this.#attachedUrl = null;
    if (!tileset) return;

    let removed = false;
    if (viewer && !isDestroyed(viewer)) {
      try {
        const primitives = viewer.scene?.primitives;
        if (primitives && typeof primitives.remove === "function") {
          removed = primitives.remove(tileset) === true;
        }
        viewer.scene?.requestRender?.();
      } catch {
        removed = false;
      }
    }
    if (!removed) destroyUnattachedTileset(tileset);
  }

  enable({ url = this.#url, fallbackUrl = this.#fallbackUrl } = {}) {
    if (this.#disposed) return Promise.resolve({ status: "disposed" });
    if (!this.#isEnabled()) return Promise.resolve({ status: "disabled" });

    let primaryUrl;
    let secondaryUrl;
    try {
      primaryUrl = normalizeUrl(url, "url");
      secondaryUrl = normalizeUrl(fallbackUrl, "fallbackUrl", { optional: true });
    } catch (error) {
      return Promise.reject(error);
    }

    const viewer = this.#getViewer();
    const Cesium = this.#getCesium();
    if (!viewer || isDestroyed(viewer) || typeof Cesium?.Cesium3DTileset?.fromUrl !== "function") {
      this.#emit("unavailable", { requestedUrl: primaryUrl });
      return Promise.resolve({ status: "unavailable" });
    }

    if (
      this.#tileset &&
      this.#attachedViewer === viewer &&
      this.#attachedUrl === primaryUrl &&
      !isDestroyed(this.#tileset)
    ) {
      return Promise.resolve({ status: "already-loaded", tileset: this.#tileset, url: primaryUrl });
    }

    const requestKey = JSON.stringify([primaryUrl, secondaryUrl, this.#maxAttemptsPerUrl, this.#retryDelayMs]);
    if (this.#inflight?.requestKey === requestKey && this.#inflight.viewer === viewer) {
      return this.#inflight.promise;
    }

    // A different URL or viewer supersedes any pending load and removes older
    // attached content first. The generation guard cleans up any late old result.
    this.#revision += 1;
    const revision = this.#revision;
    this.#inflight = null;
    this.#detachAttached();
    this.#loading = true;
    const flight = { requestKey, revision, viewer, promise: null };
    flight.promise = this.#load({
      revision,
      viewer,
      Cesium,
      primaryUrl,
      secondaryUrl,
    }).finally(() => {
      if (this.#inflight === flight) this.#inflight = null;
      if (revision === this.#revision) this.#loading = false;
    });
    this.#inflight = flight;
    return flight.promise;
  }

  async #load({ revision, viewer, Cesium, primaryUrl, secondaryUrl }) {
    const candidates = secondaryUrl && secondaryUrl !== primaryUrl
      ? [primaryUrl, secondaryUrl]
      : [primaryUrl];
    this.#emit("loading", {
      requestedUrl: primaryUrl,
      fallbackConfigured: candidates.length > 1,
      maxAttemptsPerUrl: this.#maxAttemptsPerUrl,
    });

    let loadedTileset = null;
    let loadedUrl = null;
    const failures = [];

    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      const candidateUrl = candidates[candidateIndex];
      for (let attempt = 1; attempt <= this.#maxAttemptsPerUrl; attempt += 1) {
        if (!this.#isCurrent(revision, viewer)) return { status: "cancelled" };
        try {
          loadedTileset = await Cesium.Cesium3DTileset.fromUrl(candidateUrl, {
            maximumScreenSpaceError: 16,
          });
          loadedUrl = candidateUrl;
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push({ url: candidateUrl, attempt, message });
          if (!this.#isCurrent(revision, viewer)) return { status: "cancelled" };
          if (attempt < this.#maxAttemptsPerUrl) {
            this.#emit("retrying", {
              requestedUrl: primaryUrl,
              attempt,
              nextAttempt: attempt + 1,
              maxAttemptsPerUrl: this.#maxAttemptsPerUrl,
              failedUrl: candidateUrl,
              message,
            });
            await wait(this.#retryDelayMs);
            if (!this.#isCurrent(revision, viewer)) return { status: "cancelled" };
            continue;
          }
          if (candidateIndex < candidates.length - 1) {
            this.#emit("fallback", {
              requestedUrl: primaryUrl,
              fromUrl: candidateUrl,
              toUrl: candidates[candidateIndex + 1],
              failedAttempts: failures.filter((failure) => failure.url === candidateUrl).length,
              message,
            });
          } else {
            this.#emit("error", {
              requestedUrl: primaryUrl,
              attempts: failures,
              message,
            });
          }
        }
      }
      if (loadedTileset) break;
    }

    if (!this.#isCurrent(revision, viewer)) {
      destroyUnattachedTileset(loadedTileset);
      return { status: "cancelled" };
    }

    if (!loadedTileset) {
      this.#loading = false;
      const lastFailure = failures[failures.length - 1];
      throw new Error(lastFailure?.message ?? "No 3D Tiles URL could be loaded.");
    }

    const primitives = viewer.scene?.primitives;
    if (!primitives || typeof primitives.add !== "function") {
      destroyUnattachedTileset(loadedTileset);
      this.#loading = false;
      const error = new Error("Cesium scene primitive collection is unavailable for the Dhaka 3D Tiles pilot.");
      this.#emit("error", {
        requestedUrl: primaryUrl,
        loadedUrl,
        message: error.message,
        failures,
      });
      throw error;
    }

    try {
      primitives.add(loadedTileset);
    } catch (error) {
      // A custom primitive collection can throw after mutating its collection.
      // Attempt removal before direct destruction so a partially-added primitive
      // cannot remain referenced by a live scene.
      let removedAfterFailedAdd = false;
      try {
        if (typeof primitives.remove === "function") {
          removedAfterFailedAdd = primitives.remove(loadedTileset) === true;
        }
      } catch {
        removedAfterFailedAdd = false;
      }
      if (!removedAfterFailedAdd) destroyUnattachedTileset(loadedTileset);
      this.#loading = false;
      const message = error instanceof Error ? error.message : String(error);
      this.#emit("error", { requestedUrl: primaryUrl, loadedUrl, message, failures });
      throw error;
    }

    this.#loading = false;
    this.#tileset = loadedTileset;
    this.#attachedViewer = viewer;
    this.#attachedUrl = loadedUrl;
    viewer.scene.requestRender?.();
    const result = {
      status: "loaded",
      tileset: loadedTileset,
      url: loadedUrl,
      requestedUrl: primaryUrl,
      fallbackUsed: loadedUrl !== primaryUrl,
      failedAttempts: failures,
    };
    // Keep the configured URL stable; an explicit one-shot URL does not silently
    // rewrite the controller's default source for later enable() calls.
    this.#emit("loaded", {
      requestedUrl: primaryUrl,
      loadedUrl,
      fallbackUsed: result.fallbackUsed,
      failedAttempts: failures,
      worldCenter: resolveWorldCenter(Cesium, loadedTileset),
    });
    return result;
  }

  disable() {
    this.#revision += 1;
    const wasActive = this.#loading || Boolean(this.#tileset) || Boolean(this.#inflight);
    this.#loading = false;
    this.#inflight = null;
    this.#detachAttached();
    if (!this.#disposed && wasActive) this.#emit("disabled");
  }

  destroy() {
    if (this.#disposed) return;
    this.disable();
    this.#disposed = true;
    this.#onStatus = null;
  }

  getState() {
    return {
      enabled: !this.#disposed && this.#isEnabled(),
      loadingOrAttached: this.#loading || Boolean(this.#tileset),
      loading: this.#loading,
      attached: Boolean(this.#tileset) && !isDestroyed(this.#tileset),
      attachedUrl: this.#attachedUrl,
      fallbackConfigured: Boolean(this.#fallbackUrl),
      disposed: this.#disposed,
    };
  }
}
