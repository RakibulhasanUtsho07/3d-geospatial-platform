/**
 * Owns the browser event-handler lifecycle for Cesium feature picking.
 *
 * The controller deliberately delegates pick interpretation and all map state
 * changes to its caller. It only binds the left-click callback and rejects
 * callbacks from a replaced handler or an inactive/destroyed map instance.
 */
export class FeaturePickingController {
  constructor({ createHandler, leftClickType, isActive, onPick }) {
    if (typeof createHandler !== "function") {
      throw new TypeError("createHandler must be a function");
    }
    if (typeof isActive !== "function") {
      throw new TypeError("isActive must be a function");
    }
    if (typeof onPick !== "function") {
      throw new TypeError("onPick must be a function");
    }

    this.createHandler = createHandler;
    this.leftClickType = leftClickType;
    this.isActive = isActive;
    this.onPick = onPick;
    this.handler = null;
    this.destroyed = false;
  }

  attach(canvas) {
    if (this.destroyed) return;

    this.destroyHandler();
    const handler = this.createHandler(canvas);
    this.handler = handler;

    try {
      handler.setInputAction((movement) => {
        if (
          this.destroyed ||
          this.handler !== handler ||
          !this.isActive()
        ) {
          return;
        }

        this.onPick(movement);
      }, this.leftClickType);
    } catch (error) {
      if (this.handler === handler) {
        this.handler = null;
      }
      handler.destroy();
      throw error;
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.destroyHandler();
  }

  destroyHandler() {
    const handler = this.handler;
    this.handler = null;
    handler?.destroy();
  }
}
