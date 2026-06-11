// Victoria, BC operating area. Bounding box covers the inner harbour,
// Race Rocks, Haro/Juan de Fuca approaches, and the Active Pass channel
// — i.e. the busy water that the dark-vessel demo cares about.

export const VICTORIA_BBOX = {
  // [southwest_lat, southwest_lon] / [northeast_lat, northeast_lon]
  sw: [48.20, -123.70],
  ne: [48.65, -123.05],
};

export const VICTORIA_CENTER = { lat: 48.4284, lon: -123.3656 };

export function insideBBox(lat, lon, bbox = VICTORIA_BBOX) {
  return lat >= bbox.sw[0] && lat <= bbox.ne[0] && lon >= bbox.sw[1] && lon <= bbox.ne[1];
}

// Haversine distance in nautical miles.
export function nmBetween(lat1, lon1, lat2, lon2) {
  const R_KM = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const km = 2 * R_KM * Math.asin(Math.sqrt(a));
  return km * 0.539957;
}

// Pretty-print "48.4284N 123.3656W" from signed decimals.
export function formatLatLon(lat, lon) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(4)}${ns} ${Math.abs(lon).toFixed(4)}${ew}`;
}
