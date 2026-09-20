/**
 * Mirrors the public read-tool argument boundary used by the runtime facade.
 *
 * Structured output is not trusted as validation by itself. The isolated eval
 * runner checks arguments before returning seeded facts, and graders check the
 * observation again so a schema drift becomes an explicit evaluation failure.
 */
export function validateCustomerAiEvalToolArguments(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  if (toolName !== 'search_restaurants' && toolName !== 'search_menu_items') {
    return 'tool_not_allowlisted';
  }
  const allowed = new Set([
    'q',
    'city',
    'state',
    'country',
    'lat',
    'lng',
    'radiusKm',
    'limit',
    ...(toolName === 'search_menu_items' ? ['fulfillmentType'] : []),
  ]);
  if (Object.keys(args).some((key) => !allowed.has(key))) {
    return 'unexpected_argument';
  }
  for (const [name, maximumLength] of [
    ['q', 120],
    ['city', 100],
    ['state', 100],
    ['country', 100],
  ] as const) {
    const value = args[name];
    if (
      value !== undefined &&
      value !== null &&
      (typeof value !== 'string' || value.trim().length > maximumLength)
    ) {
      return `${name}_invalid`;
    }
  }
  const lat = optionalNumber(args.lat);
  const lng = optionalNumber(args.lng);
  if (lat === 'invalid' || lng === 'invalid') return 'coordinates_invalid';
  if ((lat === null) !== (lng === null)) return 'incomplete_coordinates';
  if (lat !== null && (lat < -90 || lat > 90)) {
    return 'latitude_out_of_bounds';
  }
  if (lng !== null && (lng < -180 || lng > 180)) {
    return 'longitude_out_of_bounds';
  }
  const radiusKm = optionalNumber(args.radiusKm);
  if (radiusKm === 'invalid') return 'radius_invalid';
  if (radiusKm !== null && (radiusKm < 0.1 || radiusKm > 100)) {
    return 'radius_out_of_bounds';
  }
  if (
    args.limit !== undefined &&
    args.limit !== null &&
    (!Number.isInteger(args.limit) ||
      Number(args.limit) < 1 ||
      Number(args.limit) > 4)
  ) {
    return 'limit_out_of_bounds';
  }
  if (
    toolName === 'search_menu_items' &&
    args.fulfillmentType !== undefined &&
    args.fulfillmentType !== null &&
    args.fulfillmentType !== 'pickup' &&
    args.fulfillmentType !== 'delivery'
  ) {
    return 'fulfillment_type_invalid';
  }

  return null;
}

function optionalNumber(value: unknown): number | null | 'invalid' {
  if (value === undefined || value === null) return null;

  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : 'invalid';
}
