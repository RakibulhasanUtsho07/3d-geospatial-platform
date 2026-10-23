import { normalizeGeneratedModelDefinition } from "./generated-model-policy.mjs";
import type { GeneratedModelDefinition, GeneratedModelUpdate } from "./types";

type CesiumModule = typeof import("cesium");
type CesiumViewer = import("cesium").Viewer;

type GeneratedModelRecord = {
  definition: GeneratedModelDefinition;
  model: import("cesium").Model | null;
  revision: number;
  visibilityRevision: number;
};

/**
 * Owns GLB-backed model primitives independently of the main map adapter.
 *
 * The host supplies the current viewer/Cesium module as getters so in-flight loads
 * can be invalidated when the map is destroyed or re-created.
 */
export class GeneratedModelLayer {
  private readonly records = new Map<string, GeneratedModelRecord>();

  constructor(
    private readonly getViewer: () => CesiumViewer | null,
    private readonly getCesium: () => CesiumModule | null,
  ) {}

  private createModelMatrix(
    definition: GeneratedModelDefinition,
    Cesium: CesiumModule,
  ): import("cesium").Matrix4 {
    const origin = Cesium.Cartesian3.fromDegrees(
      definition.position.longitude,
      definition.position.latitude,
      definition.position.height ?? 0,
    );
    const orientation = new Cesium.HeadingPitchRoll(
      Cesium.Math.toRadians(definition.headingDegrees ?? 0),
      Cesium.Math.toRadians(definition.pitchDegrees ?? 0),
      Cesium.Math.toRadians(definition.rollDegrees ?? 0),
    );
    return Cesium.Transforms.headingPitchRollToFixedFrame(
      origin,
      orientation,
      Cesium.Ellipsoid.WGS84,
      Cesium.Transforms.eastNorthUpToFixedFrame,
    );
  }

  private resolveAxis(axis: "X" | "Y" | "Z", Cesium: CesiumModule) {
    if (axis === "X") return Cesium.Axis.X;
    if (axis === "Z") return Cesium.Axis.Z;
    return Cesium.Axis.Y;
  }

  private async createModelInstance(
    definition: GeneratedModelDefinition,
    viewer: CesiumViewer,
    Cesium: CesiumModule,
  ): Promise<import("cesium").Model> {
    const options = {
      url: definition.url,
      modelMatrix: this.createModelMatrix(definition, Cesium),
      scale: definition.scale ?? 1,
      minimumPixelSize: definition.minimumPixelSize ?? 0,
      upAxis: this.resolveAxis(definition.upAxis ?? "Y", Cesium),
      forwardAxis: this.resolveAxis(definition.forwardAxis ?? "Z", Cesium),
      ...(definition.maximumScale === undefined ? {} : { maximumScale: definition.maximumScale }),
    };
    const model = await Cesium.Model.fromGltfAsync(options);
    if (this.getViewer() !== viewer || viewer.isDestroyed()) {
      if (!model.isDestroyed()) model.destroy();
      throw new Error("The map was destroyed while the generated model was loading.");
    }
    return model;
  }

  /** Add one normalized GLB model. Duplicate IDs remain an error. */
  async add(definition: GeneratedModelDefinition): Promise<void> {
    const normalized = normalizeGeneratedModelDefinition(definition);
    const viewer = this.getViewer();
    const Cesium = this.getCesium();
    if (!viewer || !Cesium || viewer.isDestroyed()) {
      throw new Error("The map must be initialized before adding a generated model.");
    }
    if (this.records.has(normalized.id)) {
      throw new Error("A generated model with ID \"" + normalized.id + "\" already exists.");
    }

    const record: GeneratedModelRecord = {
      definition: normalized,
      model: null,
      revision: 1,
      visibilityRevision: 0,
    };
    const revision = record.revision;
    this.records.set(normalized.id, record);
    let model: import("cesium").Model | null = null;
    try {
      model = await this.createModelInstance(normalized, viewer, Cesium);
      if (
        this.getViewer() !== viewer ||
        viewer.isDestroyed() ||
        this.records.get(normalized.id) !== record ||
        record.revision !== revision
      ) {
        if (!model.isDestroyed()) model.destroy();
        return;
      }
      model.show = record.definition.show ?? true;
      viewer.scene.primitives.add(model);
      record.model = model;
      viewer.scene.requestRender();
    } catch (error: unknown) {
      if (model && !model.isDestroyed() && record.model !== model) model.destroy();
      if (this.records.get(normalized.id) === record && record.model === null) {
        this.records.delete(normalized.id);
      }
      throw error;
    }
  }

  /** Stage a replacement asset before removing the old model primitive. */
  async update(id: string, patch: GeneratedModelUpdate): Promise<void> {
    const record = this.records.get(id);
    if (!record) throw new Error("Generated model not found: " + id);
    const viewer = this.getViewer();
    const Cesium = this.getCesium();
    if (!viewer || !Cesium || viewer.isDestroyed()) {
      throw new Error("The map must be initialized before updating a generated model.");
    }
    const nextDefinition = normalizeGeneratedModelDefinition({ ...record.definition, ...patch, id });
    const visibilityRevision = record.visibilityRevision;
    const revision = ++record.revision;

    if (record.model && nextDefinition.url === record.definition.url) {
      record.model.modelMatrix = this.createModelMatrix(nextDefinition, Cesium);
      record.model.scale = nextDefinition.scale ?? 1;
      record.model.minimumPixelSize = nextDefinition.minimumPixelSize ?? 0;
      if (nextDefinition.maximumScale !== undefined) {
        record.model.maximumScale = nextDefinition.maximumScale;
      }
      record.model.show = nextDefinition.show ?? true;
      record.definition = nextDefinition;
      viewer.scene.requestRender();
      return;
    }

    let replacement: import("cesium").Model | null = null;
    try {
      replacement = await this.createModelInstance(nextDefinition, viewer, Cesium);
      if (
        this.getViewer() !== viewer ||
        viewer.isDestroyed() ||
        this.records.get(id) !== record ||
        record.revision !== revision
      ) {
        if (!replacement.isDestroyed()) replacement.destroy();
        return;
      }
      replacement.show = false;
      viewer.scene.primitives.add(replacement);
      const previous = record.model;
      const desiredShow = record.visibilityRevision !== visibilityRevision
        ? (record.definition.show ?? true)
        : (nextDefinition.show ?? true);
      record.model = replacement;
      record.definition = normalizeGeneratedModelDefinition({ ...nextDefinition, show: desiredShow });
      replacement.show = desiredShow;
      if (previous && !previous.isDestroyed()) viewer.scene.primitives.remove(previous);
      viewer.scene.requestRender();
    } catch (error: unknown) {
      if (replacement && !replacement.isDestroyed() && record.model !== replacement) {
        replacement.destroy();
      }
      throw error;
    }
  }

  setVisibility(id: string, visible: boolean): boolean {
    const record = this.records.get(id);
    if (!record) return false;
    if (typeof visible !== "boolean") throw new TypeError("Model visibility must be a boolean.");
    record.visibilityRevision += 1;
    record.definition = normalizeGeneratedModelDefinition({ ...record.definition, show: visible });
    if (record.model && !record.model.isDestroyed()) record.model.show = visible;
    const viewer = this.getViewer();
    if (viewer && !viewer.isDestroyed()) viewer.scene.requestRender();
    return true;
  }

  remove(id: string): boolean {
    const record = this.records.get(id);
    if (!record) return false;
    record.revision += 1;
    this.records.delete(id);
    const viewer = this.getViewer();
    if (record.model && !record.model.isDestroyed() && viewer && !viewer.isDestroyed()) {
      viewer.scene.primitives.remove(record.model);
      viewer.scene.requestRender();
    }
    return true;
  }

  getIds(): string[] {
    return [...this.records.keys()];
  }

  /** Invalidate asynchronous loads before the host destroys its Cesium viewer. */
  destroy(): void {
    for (const record of this.records.values()) record.revision += 1;
    this.records.clear();
  }
}
