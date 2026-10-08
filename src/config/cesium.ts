const cesiumIonToken =
  process.env.NEXT_PUBLIC_CESIUM_ION_TOKEN;

export function getCesiumIonToken(): string {
  if (!cesiumIonToken) {
    throw new Error(
      "Missing NEXT_PUBLIC_CESIUM_ION_TOKEN environment variable.",
    );
  }

  return cesiumIonToken;
}