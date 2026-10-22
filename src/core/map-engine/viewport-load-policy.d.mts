export function shouldAbortViewportRequest(
  activeEndpoint: string | null,
  nextEndpoint: string,
): boolean;

export function shouldLoadFullDatasetForWideViewport(
  hasLoadedBuildings: boolean,
  loadedViewportBounds: {
    west: number;
    south: number;
    east: number;
    north: number;
  } | null,
): boolean;

export function shouldContinueViewportLoad(
  requestRevision: number,
  currentRevision: number,
  buildingsLayerVisible: boolean,
): boolean;
export function shouldContinueViewportStage(
  requestRevision: number,
  currentRevision: number,
  buildingsLayerVisible: boolean,
  viewerIsCurrent: boolean,
): boolean;
