import type {
  CameraTarget,
  MapEngine,
  MapEngineState,
} from "@/core/map-engine";

export const HOME_CAMERA_VIEW: CameraTarget = {
  destination: {
    longitude: 90.4125,
    latitude: 23.8103,
    height: 15000,
  },
  heading: 0,
  pitch: -40,
  roll: 0,
  durationMs: 2500,
};

export class CameraController {
  constructor(private readonly engine: MapEngine) {}

  home(): void {
    this.engine.flyTo(HOME_CAMERA_VIEW);
  }

  focus(target: CameraTarget): void {
    this.engine.flyTo(target);
  }

  zoomIn(): void {
    this.engine.zoomIn();
  }

  zoomOut(): void {
    this.engine.zoomOut();
  }

  rotateLeft(): void {
    this.engine.rotateLeft(15);
  }

  rotateRight(): void {
    this.engine.rotateRight(15);
  }

  tiltUp(): void {
    this.engine.tiltUp(8);
  }

  tiltDown(): void {
    this.engine.tiltDown(8);
  }

  resetOrientation(): void {
    this.engine.resetOrientation();
  }

  getState(): MapEngineState {
    return this.engine.getState();
  }
}