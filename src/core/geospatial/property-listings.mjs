export const PROPERTY_TYPES = Object.freeze({
  apartment: "Apartment",
  house: "House / villa",
  studio: "Studio",
  office: "Office",
  shop: "Retail / shop",
});

const DEFAULT_RADIUS_METERS = 5000;
const MIN_RADIUS_METERS = 250;
const MAX_RADIUS_METERS = 20000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_RENT_BDT = 10000000;
const MAX_BEDROOMS = 20;

/* Pilot-only illustrative records: these are not real or verified advertisements. */
const SAMPLE_LISTINGS = Object.freeze([
  { id: "dhk-dhanmondi-a01", title: "Bright family apartment", propertyType: "apartment", area: "Dhanmondi", neighborhood: "Dhanmondi 8/A", latitude: 23.7461, longitude: 90.3742, monthlyRentBdt: 35000, bedrooms: 3, bathrooms: 2, areaSqft: 1350, furnishing: "semi-furnished", availableFrom: "2026-11-01", description: "Illustrative three-bedroom listing near local shops and everyday services." },
  { id: "dhk-dhanmondi-a02", title: "Compact two-bedroom flat", propertyType: "apartment", area: "Dhanmondi", neighborhood: "Dhanmondi 15", latitude: 23.749, longitude: 90.371, monthlyRentBdt: 22000, bedrooms: 2, bathrooms: 1, areaSqft: 900, furnishing: "unfurnished", availableFrom: "2026-11-15", description: "Illustrative rental record with a practical two-bedroom layout." },
  { id: "dhk-gulshan-a01", title: "Spacious executive apartment", propertyType: "apartment", area: "Gulshan", neighborhood: "Gulshan 2", latitude: 23.7925, longitude: 90.4144, monthlyRentBdt: 85000, bedrooms: 3, bathrooms: 3, areaSqft: 1950, furnishing: "furnished", availableFrom: "2026-11-01", description: "Illustrative furnished apartment record for testing higher-rent filters." },
  { id: "dhk-banani-a01", title: "Modern two-bedroom apartment", propertyType: "apartment", area: "Banani", neighborhood: "Banani 11", latitude: 23.793, longitude: 90.4043, monthlyRentBdt: 64000, bedrooms: 2, bathrooms: 2, areaSqft: 1250, furnishing: "furnished", availableFrom: "2026-10-20", description: "Illustrative city apartment with a two-bedroom floor plan." },
  { id: "dhk-uttara-a01", title: "Family flat near sector roads", propertyType: "apartment", area: "Uttara", neighborhood: "Uttara Sector 7", latitude: 23.875, longitude: 90.379, monthlyRentBdt: 26000, bedrooms: 3, bathrooms: 2, areaSqft: 1250, furnishing: "unfurnished", availableFrom: "2026-11-05", description: "Illustrative family rental record in the Uttara pilot area." },
  { id: "dhk-mirpur-a01", title: "Budget two-bedroom apartment", propertyType: "apartment", area: "Mirpur", neighborhood: "Mirpur 10", latitude: 23.806, longitude: 90.366, monthlyRentBdt: 18000, bedrooms: 2, bathrooms: 1, areaSqft: 850, furnishing: "unfurnished", availableFrom: "2026-10-25", description: "Illustrative lower-rent apartment for testing budget filters." },
  { id: "dhk-bashundhara-a01", title: "Three-bedroom residence", propertyType: "apartment", area: "Bashundhara", neighborhood: "Bashundhara R/A", latitude: 23.8175, longitude: 90.425, monthlyRentBdt: 32000, bedrooms: 3, bathrooms: 2, areaSqft: 1420, furnishing: "semi-furnished", availableFrom: "2026-11-01", description: "Illustrative three-bedroom listing in the Bashundhara pilot area." },
  { id: "dhk-mohammadpur-a01", title: "Convenient two-bedroom home", propertyType: "apartment", area: "Mohammadpur", neighborhood: "Mohammadpur Town Hall", latitude: 23.763, longitude: 90.358, monthlyRentBdt: 21000, bedrooms: 2, bathrooms: 2, areaSqft: 960, furnishing: "semi-furnished", availableFrom: "2026-11-10", description: "Illustrative home record for nearby-service comparison testing." },
  { id: "dhk-badda-a01", title: "Affordable family apartment", propertyType: "apartment", area: "Badda", neighborhood: "Middle Badda", latitude: 23.7804, longitude: 90.426, monthlyRentBdt: 24000, bedrooms: 2, bathrooms: 2, areaSqft: 1050, furnishing: "unfurnished", availableFrom: "2026-10-28", description: "Illustrative rental record with two bedrooms and two bathrooms." },
  { id: "dhk-farmgate-a01", title: "Central two-bedroom flat", propertyType: "apartment", area: "Farmgate", neighborhood: "Indira Road", latitude: 23.757, longitude: 90.389, monthlyRentBdt: 28000, bedrooms: 2, bathrooms: 1, areaSqft: 980, furnishing: "semi-furnished", availableFrom: "2026-11-01", description: "Illustrative central-Dhaka rental record." },
  { id: "dhk-mirpur-h01", title: "Small family house", propertyType: "house", area: "Mirpur", neighborhood: "Mirpur 2", latitude: 23.8173, longitude: 90.3572, monthlyRentBdt: 30000, bedrooms: 3, bathrooms: 2, areaSqft: 1600, furnishing: "unfurnished", availableFrom: "2026-12-01", description: "Illustrative standalone house record for property-type filtering." },
  { id: "dhk-gulshan-s01", title: "Compact studio suite", propertyType: "studio", area: "Gulshan", neighborhood: "Gulshan 1", latitude: 23.7801, longitude: 90.4161, monthlyRentBdt: 30000, bedrooms: 1, bathrooms: 1, areaSqft: 560, furnishing: "furnished", availableFrom: "2026-10-25", description: "Illustrative studio record with a compact furnishing profile." },
  { id: "dhk-tejgaon-o01", title: "Small creative office", propertyType: "office", area: "Tejgaon", neighborhood: "Tejgaon Industrial Area", latitude: 23.7653, longitude: 90.3998, monthlyRentBdt: 55000, bedrooms: 0, bathrooms: 1, areaSqft: 1100, furnishing: "semi-furnished", availableFrom: "2026-11-15", description: "Illustrative office-space record, not a live commercial offer." },
  { id: "dhk-newmarket-s01", title: "Street-facing retail unit", propertyType: "shop", area: "New Market", neighborhood: "Nilkhet", latitude: 23.7332, longitude: 90.3852, monthlyRentBdt: 45000, bedrooms: 0, bathrooms: 1, areaSqft: 420, furnishing: "unfurnished", availableFrom: "2026-12-01", description: "Illustrative retail unit for commercial property filters." },
]);

function isFiniteRange(value, min, max) {
  return Number.isFinite(value) && value >= min && value <= max;
}

function readInteger(params, key, fallback, min, max) {
  const raw = params.get(key);
  if (raw === null) return { ok: true, value: fallback };
  const value = Number(raw);
  if (!Number.isInteger(value) || !isFiniteRange(value, min, max)) {
    return { ok: false, error: key + " must be a whole number between " + min + " and " + max + "." };
  }
  return { ok: true, value };
}

export function parsePropertySearchParams(params) {
  const rawLatitude = params.get("lat");
  const rawLongitude = params.get("lon");
  if (rawLatitude === null || rawLongitude === null) {
    return { ok: false, error: "Latitude (lat) and longitude (lon) are required." };
  }

  const latitude = Number(rawLatitude);
  const longitude = Number(rawLongitude);
  if (!isFiniteRange(latitude, -90, 90) || !isFiniteRange(longitude, -180, 180)) {
    return { ok: false, error: "Latitude must be between -90 and 90 and longitude between -180 and 180." };
  }

  const radius = readInteger(params, "radius", DEFAULT_RADIUS_METERS, MIN_RADIUS_METERS, MAX_RADIUS_METERS);
  if (!radius.ok) return radius;
  const limit = readInteger(params, "limit", DEFAULT_LIMIT, 1, MAX_LIMIT);
  if (!limit.ok) return limit;
  const minRent = readInteger(params, "minRent", 0, 0, MAX_RENT_BDT);
  if (!minRent.ok) return minRent;
  const maxRent = readInteger(params, "maxRent", MAX_RENT_BDT, 0, MAX_RENT_BDT);
  if (!maxRent.ok) return maxRent;
  if (minRent.value > maxRent.value) {
    return { ok: false, error: "Minimum rent cannot be greater than maximum rent." };
  }
  const minBedrooms = readInteger(params, "minBedrooms", 0, 0, MAX_BEDROOMS);
  if (!minBedrooms.ok) return minBedrooms;

  const rawType = params.get("type")?.trim() || "all";
  if (rawType !== "all" && !Object.hasOwn(PROPERTY_TYPES, rawType)) {
    return { ok: false, error: "Choose a supported property type." };
  }
  const furnishing = params.get("furnishing")?.trim() || "all";
  if (!["all", "unfurnished", "semi-furnished", "furnished"].includes(furnishing)) {
    return { ok: false, error: "Choose a supported furnishing option." };
  }

  const query = params.get("q")?.trim() || "";
  if (query.length === 1 || query.length > 100) {
    return { ok: false, error: "Search text must be empty or contain between 2 and 100 characters." };
  }

  const savedIds = [...new Set((params.get("savedIds") || "").split(",").map((value) => value.trim()).filter(Boolean))];
  if (savedIds.length > 100 || savedIds.some((id) => !/^[a-z0-9-]{1,80}$/i.test(id))) {
    return { ok: false, error: "Saved property IDs are invalid or exceed the supported limit." };
  }
  const savedOnly = params.get("savedOnly") || "false";
  if (!["true", "false"].includes(savedOnly)) {
    return { ok: false, error: "savedOnly must be true or false." };
  }

  return {
    ok: true,
    value: {
      latitude,
      longitude,
      radiusMeters: radius.value,
      limit: limit.value,
      minRentBdt: minRent.value,
      maxRentBdt: maxRent.value,
      minBedrooms: minBedrooms.value,
      propertyType: rawType,
      furnishing,
      query: query.toLocaleLowerCase("en"),
      savedOnly: savedOnly === "true",
      savedIds,
    },
  };
}

export function calculateDistanceMeters(latitudeA, longitudeA, latitudeB, longitudeB) {
  const radians = Math.PI / 180;
  const deltaLatitude = (latitudeB - latitudeA) * radians;
  const deltaLongitude = (longitudeB - longitudeA) * radians;
  const a = Math.sin(deltaLatitude / 2) ** 2
    + Math.cos(latitudeA * radians) * Math.cos(latitudeB * radians)
    * Math.sin(deltaLongitude / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function searchPropertyListings(request) {
  const savedIds = new Set(request.savedIds || []);
  const results = [];

  for (const listing of SAMPLE_LISTINGS) {
    const distanceMeters = Math.round(calculateDistanceMeters(
      request.latitude, request.longitude, listing.latitude, listing.longitude,
    ));
    if (request.savedOnly && !savedIds.has(listing.id)) continue;
    if (!request.savedOnly && distanceMeters > request.radiusMeters) continue;
    if (listing.monthlyRentBdt < request.minRentBdt || listing.monthlyRentBdt > request.maxRentBdt) continue;
    if (listing.bedrooms < request.minBedrooms) continue;
    if (request.propertyType !== "all" && listing.propertyType !== request.propertyType) continue;
    if (request.furnishing !== "all" && listing.furnishing !== request.furnishing) continue;

    if (request.query) {
      const searchable = [listing.title, listing.area, listing.neighborhood, listing.propertyType, listing.furnishing, listing.description]
        .join(" ").toLocaleLowerCase("en");
      if (!searchable.includes(request.query)) continue;
    }

    results.push({
      ...listing,
      propertyTypeLabel: PROPERTY_TYPES[listing.propertyType],
      distanceMeters,
      source: "illustrative-demo-seed",
      verified: false,
      liveAvailability: false,
    });
  }

  results.sort((left, right) => left.distanceMeters - right.distanceMeters
    || left.monthlyRentBdt - right.monthlyRentBdt
    || left.id.localeCompare(right.id));

  return {
    totalMatches: results.length,
    returnedCount: Math.min(results.length, request.limit),
    radiusMeters: request.radiusMeters,
    results: results.slice(0, request.limit),
  };
}

export function matchNearbyServices(property, places, maxDistanceMeters = 1500) {
  if (!Array.isArray(places) || !Number.isFinite(maxDistanceMeters) || maxDistanceMeters < 0) return [];
  const nearestByCategory = new Map();

  for (const place of places) {
    if (!place || typeof place.category !== "string"
      || !Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)) continue;
    const distanceFromPropertyMeters = Math.round(calculateDistanceMeters(
      property.latitude, property.longitude, place.latitude, place.longitude,
    ));
    if (distanceFromPropertyMeters > maxDistanceMeters) continue;
    const candidate = { ...place, distanceFromPropertyMeters };
    const previous = nearestByCategory.get(place.category);
    if (!previous || distanceFromPropertyMeters < previous.distanceFromPropertyMeters) {
      nearestByCategory.set(place.category, candidate);
    }
  }

  return [...nearestByCategory.values()].sort((left, right) =>
    left.distanceFromPropertyMeters - right.distanceFromPropertyMeters
    || left.category.localeCompare(right.category));
}

export const PROPERTY_LISTING_LIMITS = Object.freeze({
  defaultRadiusMeters: DEFAULT_RADIUS_METERS,
  minRadiusMeters: MIN_RADIUS_METERS,
  maxRadiusMeters: MAX_RADIUS_METERS,
  defaultLimit: DEFAULT_LIMIT,
  maxLimit: MAX_LIMIT,
  maxRentBdt: MAX_RENT_BDT,
  maxBedrooms: MAX_BEDROOMS,
});
