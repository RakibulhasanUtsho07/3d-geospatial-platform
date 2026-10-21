
const cesiumIonToken =
  process.env.NEXT_PUBLIC_CESIUM_ION_TOKEN?.trim() ?? "";

const placeholderTokens = new Set([
  "your_actual_token",
  "your_cesium_ion_token",
  "replace_me",
  "paste_your_token_here",
]);

export function getCesiumIonToken(): string {
  if (
    !cesiumIonToken ||
    placeholderTokens.has(cesiumIonToken.toLowerCase())
  ) {
    return "";
  }

  return cesiumIonToken;
}

export function hasCesiumIonToken(): boolean {
  return getCesiumIonToken().length > 0;
}