import {
  AHSAN_MANZIL_CAMERA_TARGET,
  AHSAN_MANZIL_FOOTPRINT_CAMERA_TARGET,
  AHSAN_MANZIL_CAMERA_RANGE_METERS,
  AHSAN_MANZIL_FOOTPRINT_CAMERA_RANGE_METERS,
  AHSAN_MANZIL_ORBIT_PITCH_DEGREES,
  AHSAN_MANZIL_ORBIT_DEGREES_PER_SECOND,
  AHSAN_MANZIL_FRONT_BOUNDING_RADIUS_METERS,
  AHSAN_MANZIL_FOOTPRINT_BOUNDING_RADIUS_METERS,
} from "../geospatial/heritage-landmarks.mjs";

type CesiumModule = typeof import("cesium");
type CesiumViewer = import("cesium").Viewer;
type CameraPresetTarget = "front" | "footprint";

/**
 * Owns the landmark camera presets and guided-orbit lifecycle.
 * The viewer is accessed lazily so a destroyed/re-created map cannot leave
 * an animation bound to an obsolete Cesium Viewer.
 */
export class HeritageCameraController {
  private headingDegrees = 157;
  private pitchDegrees = AHSAN_MANZIL_ORBIT_PITCH_DEGREES;
  private rangeMeters = AHSAN_MANZIL_CAMERA_RANGE_METERS;
  private animationFrame: number | null = null;
  private tourActive = false;
  private lastTimestamp: number | null = null;
  private removeInputListeners: (() => void) | null = null;
  private stoppedCallback: (() => void) | null = null;

  constructor(
    private readonly getViewer: () => CesiumViewer | null,
    private readonly getCesium: () => CesiumModule | null,
  ) {}

  /** Reproduce the initial river-facing facade view previously set by the adapter. */
  configureInitialCamera(): void {
    const viewer = this.getViewer();
    const Cesium = this.getCesium();
    if (!viewer || !Cesium || viewer.isDestroyed()) return;

    const center = Cesium.Cartesian3.fromDegrees(
      AHSAN_MANZIL_CAMERA_TARGET.longitude,
      AHSAN_MANZIL_CAMERA_TARGET.latitude,
      AHSAN_MANZIL_CAMERA_TARGET.height,
    );
    viewer.camera.lookAt(
      center,
      new Cesium.HeadingPitchRange(
        Cesium.Math.toRadians(this.headingDegrees),
        Cesium.Math.toRadians(this.pitchDegrees),
        this.rangeMeters,
      ),
    );
    // Release lookAt's local transform so regular Cesium navigation remains free.
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  }

  /** Front facade preset. */
  focusFront(durationMs = 1200): void {
    this.stopOrbitTour();
    this.headingDegrees = 157;
    this.pitchDegrees = AHSAN_MANZIL_ORBIT_PITCH_DEGREES;
    this.rangeMeters = AHSAN_MANZIL_CAMERA_RANGE_METERS;
    this.flyToLandmark(durationMs, "front");
  }

  /** Rear-facing camera preset. */
  focusRear(durationMs = 850): void {
    this.stopOrbitTour();
    this.headingDegrees = 9;
    this.pitchDegrees = -9;
    this.rangeMeters = AHSAN_MANZIL_CAMERA_RANGE_METERS;
    this.flyToLandmark(durationMs, "front");
  }

  /** East/west side camera preset. */
  focusSide(durationMs = 850): void {
    this.stopOrbitTour();
    this.headingDegrees = 83;
    this.pitchDegrees = -10;
    this.rangeMeters = AHSAN_MANZIL_CAMERA_RANGE_METERS;
    this.flyToLandmark(durationMs, "front");
  }

  /** Oblique camera showing the complete stepped footprint. */
  focusWhole(durationMs = 900): void {
    this.stopOrbitTour();
    this.headingDegrees = 145;
    this.pitchDegrees = -19;
    this.rangeMeters = AHSAN_MANZIL_FOOTPRINT_CAMERA_RANGE_METERS;
    this.flyToLandmark(durationMs, "footprint");
  }

  /** North-up view for checking footprint and orientation. */
  focusTopDown(durationMs = 850): void {
    this.stopOrbitTour();
    this.headingDegrees = 0;
    this.pitchDegrees = -88.5;
    this.rangeMeters = AHSAN_MANZIL_FOOTPRINT_CAMERA_RANGE_METERS;
    this.flyToLandmark(durationMs, "footprint");
  }

  orbit(stepDegrees: number): void {
    if (!Number.isFinite(stepDegrees)) return;
    this.stopOrbitTour();
    this.headingDegrees = ((this.headingDegrees + stepDegrees) % 360 + 360) % 360;
    this.pitchDegrees = AHSAN_MANZIL_ORBIT_PITCH_DEGREES;
    this.rangeMeters = AHSAN_MANZIL_FOOTPRINT_CAMERA_RANGE_METERS;
    this.flyToLandmark(650, "footprint");
  }

  /** Start a slow guided orbit; any direct pointer/touch input pauses it. */
  startOrbitTour(onStopped?: () => void): void {
    const viewer = this.getViewer();
    const Cesium = this.getCesium();
    if (!viewer || !Cesium || viewer.isDestroyed() || this.tourActive) return;
    if (typeof requestAnimationFrame !== "function") return;

    this.tourActive = true;
    this.stoppedCallback = onStopped ?? null;
    this.headingDegrees = 157;
    this.pitchDegrees = AHSAN_MANZIL_ORBIT_PITCH_DEGREES;
    this.rangeMeters = AHSAN_MANZIL_FOOTPRINT_CAMERA_RANGE_METERS;
    this.lastTimestamp = null;
    viewer.camera.cancelFlight();
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);

    const canvas = viewer.scene.canvas;
    const stopForUserInput = () => this.stopOrbitTour();
    canvas.addEventListener("pointerdown", stopForUserInput, { passive: true });
    canvas.addEventListener("wheel", stopForUserInput, { passive: true });
    canvas.addEventListener("touchstart", stopForUserInput, { passive: true });
    this.removeInputListeners = () => {
      canvas.removeEventListener("pointerdown", stopForUserInput);
      canvas.removeEventListener("wheel", stopForUserInput);
      canvas.removeEventListener("touchstart", stopForUserInput);
    };

    const center = Cesium.Cartesian3.fromDegrees(
      AHSAN_MANZIL_FOOTPRINT_CAMERA_TARGET.longitude,
      AHSAN_MANZIL_FOOTPRINT_CAMERA_TARGET.latitude,
      AHSAN_MANZIL_FOOTPRINT_CAMERA_TARGET.height,
    );

    const tick = (timestamp: number) => {
      if (!this.tourActive) return;
      const activeViewer = this.getViewer();
      const activeCesium = this.getCesium();
      if (!activeViewer || !activeCesium || activeViewer.isDestroyed() || activeViewer !== viewer) {
        this.stopOrbitTour();
        return;
      }

      if (this.lastTimestamp !== null) {
        const elapsed = Math.min(50, Math.max(0, timestamp - this.lastTimestamp));
        // A complete lap takes about 36 seconds: slow enough to inspect details.
        this.headingDegrees =
          (this.headingDegrees + elapsed * AHSAN_MANZIL_ORBIT_DEGREES_PER_SECOND / 1000) % 360;
      }
      this.lastTimestamp = timestamp;
      activeViewer.camera.lookAt(
        center,
        new activeCesium.HeadingPitchRange(
          activeCesium.Math.toRadians(this.headingDegrees),
          activeCesium.Math.toRadians(this.pitchDegrees),
          this.rangeMeters,
        ),
      );
      activeViewer.scene.requestRender();
      this.animationFrame = requestAnimationFrame(tick);
    };

    this.animationFrame = requestAnimationFrame(tick);
  }

  /** Stop the guided orbit while preserving the current view. Safe to call repeatedly. */
  stopOrbitTour(): void {
    const wasActive = this.tourActive;
    this.tourActive = false;
    this.lastTimestamp = null;
    if (this.animationFrame !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.animationFrame);
    }
    this.animationFrame = null;
    this.removeInputListeners?.();
    this.removeInputListeners = null;
    const callback = this.stoppedCallback;
    this.stoppedCallback = null;

    const viewer = this.getViewer();
    const Cesium = this.getCesium();
    if (viewer && Cesium && !viewer.isDestroyed()) {
      viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      viewer.scene.requestRender();
    }
    if (wasActive) callback?.();
  }

  /** Teardown variant: never schedules a caller callback during component unmount. */
  destroy(): void {
    this.stoppedCallback = null;
    this.stopOrbitTour();
  }

  private flyToLandmark(durationMs: number, target: CameraPresetTarget = "front"): void {
    const viewer = this.getViewer();
    const Cesium = this.getCesium();
    if (!viewer || !Cesium || viewer.isDestroyed()) return;

    const focus = target === "front"
      ? AHSAN_MANZIL_CAMERA_TARGET
      : AHSAN_MANZIL_FOOTPRINT_CAMERA_TARGET;
    const center = Cesium.Cartesian3.fromDegrees(focus.longitude, focus.latitude, focus.height);
    // The front target is offset to the dome axis, so a wider sphere includes the west wing.
    const bounds = new Cesium.BoundingSphere(
      center,
      target === "front"
        ? AHSAN_MANZIL_FRONT_BOUNDING_RADIUS_METERS
        : AHSAN_MANZIL_FOOTPRINT_BOUNDING_RADIUS_METERS,
    );
    viewer.camera.flyToBoundingSphere(bounds, {
      duration: Math.max(0, durationMs) / 1000,
      offset: new Cesium.HeadingPitchRange(
        Cesium.Math.toRadians(this.headingDegrees),
        Cesium.Math.toRadians(this.pitchDegrees),
        this.rangeMeters,
      ),
    });
    viewer.scene.requestRender();
  }
}
