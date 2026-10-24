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

/**
 * Owns the opt-in experimental 3D Tiles primitive lifecycle.
 *
 * Cesium's fromUrl promise is not abortable through the public API used here.
 * disable()/destroy() invalidate its revision immediately; any late tileset is
 * destroyed before it can be attached to an obsolete or disabled viewer.
 */
export class Dhaka3DTilesPilotController {
  #getViewer;
  #getCesium;
  #isEnabled;
  #onStatus;
  #url;
  #revision = 0;
  #loading = false;
  #tileset = null;
  #attachedViewer = null;
  #disposed = false;

  constructor({
    getViewer,
    getCesium,
    isEnabled,
    onStatus = () => {},
    url = DHAKA_3D_TILES_PILOT_URL,
  }) {
    if (typeof getViewer !== "function" || typeof getCesium !== "function" || typeof isEnabled !== "function") {
      throw new TypeError("Dhaka3DTilesPilotController requires viewer, Cesium and feature-flag providers.");
    }
    this.#getViewer = getViewer;
    this.#getCesium = getCesium;
    this.#isEnabled = isEnabled;
    this.#onStatus = onStatus;
    this.#url = url;
  }

  #emit(status, details = {}) {
    try {
      this.#onStatus?.({ status, url: this.#url, ...details });
    } catch {
      // Observability callbacks must not break map lifecycle.
    }
  }

  #isCurrent(revision, viewer) {
    return !this.#disposed &&
      revision === this.#revision &&
      this.#isEnabled() &&
      this.#getViewer() === viewer &&
      !isDestroyed(viewer);
  }

  async enable() {
    if (this.#disposed) return { status: "disposed" };
    if (!this.#isEnabled()) return { status: "disabled" };

    const viewer = this.#getViewer();
    const Cesium = this.#getCesium();
    if (!viewer || isDestroyed(viewer) || typeof Cesium?.Cesium3DTileset?.fromUrl !== "function") {
      this.#emit("unavailable");
      return { status: "unavailable" };
    }

    if (this.#tileset && this.#attachedViewer === viewer && !isDestroyed(this.#tileset)) {
      return { status: "already-loaded", tileset: this.#tileset };
    }

    const revision = ++this.#revision;
    this.#loading = true;
    this.#emit("loading");
    let tileset;

    try {
      tileset = await Cesium.Cesium3DTileset.fromUrl(this.#url, {
        maximumScreenSpaceError: 16,
      });

      if (!this.#isCurrent(revision, viewer)) {
        if (revision === this.#revision) {
          this.#loading = false;
          this.#emit("cancelled");
        }
        destroyUnattachedTileset(tileset);
        return { status: "cancelled" };
      }

      const primitives = viewer.scene?.primitives;
      if (!primitives || typeof primitives.add !== "function") {
        destroyUnattachedTileset(tileset);
        throw new Error("Cesium scene primitive collection is unavailable for the Dhaka 3D Tiles pilot.");
      }

      this.#loading = false;
      primitives.add(tileset);
      this.#tileset = tileset;
      this.#attachedViewer = viewer;
      viewer.scene.requestRender?.();
      this.#emit("loaded");
      return { status: "loaded", tileset };
    } catch (error) {
      if (revision === this.#revision) this.#loading = false;
      if (tileset && !this.#tileset) destroyUnattachedTileset(tileset);
      if (this.#isCurrent(revision, viewer)) this.#emit("error", {
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  disable() {
    this.#revision += 1;
    const wasActive = this.#loading || Boolean(this.#tileset);
    this.#loading = false;
    const tileset = this.#tileset;
    const viewer = this.#attachedViewer;
    this.#tileset = null;
    this.#attachedViewer = null;

    if (tileset) {
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
      attached: Boolean(this.#tileset) && !isDestroyed(this.#tileset),
      disposed: this.#disposed,
    };
  }
}
