import type { ScreenSpaceEventHandler } from "cesium";

export type FeaturePickMovement = {
  position: import("cesium").Cartesian2;
};

export type FeaturePickingHandler = Pick<
  ScreenSpaceEventHandler,
  "setInputAction" | "destroy"
>;

export type FeaturePickingControllerOptions = {
  createHandler: (canvas: HTMLCanvasElement) => FeaturePickingHandler;
  leftClickType: number;
  isActive: () => boolean;
  onPick: (movement: FeaturePickMovement) => void;
};

/**
 * Owns one Cesium left-click handler while leaving feature resolution and
 * selection-state transitions with the adapter.
 */
export class FeaturePickingController {
  constructor(options: FeaturePickingControllerOptions);
  attach(canvas: HTMLCanvasElement): void;
  destroy(): void;
}
