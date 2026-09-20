import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  StorefrontDirectorySearchService,
  type StorefrontDirectorySearchResult,
} from '@modules/storefront-search/storefront-directory-search.service';
import { StorefrontMenuItemSearchService } from '@modules/storefront-search/storefront-menu-item-search.service';
import type { StorefrontMenuItemSearchResult } from '@modules/storefront-search/types/storefront-menu-item-search-response.type';
import type {
  CustomerAiToolCall,
  CustomerAiToolExecutionContext,
  CustomerAiToolExecutionResult,
} from './customer-ai.types';

const MAX_RESULTS = 4;

/**
 * Executes the model's allowlisted, read-only discovery tools.
 *
 * Domain search services remain authoritative. Results are reduced to a small,
 * sanitized shape and assigned opaque run-scoped refs. The provider can select
 * those refs, but cannot manufacture a database ID that the response compiler
 * will trust.
 */
@Injectable()
export class CustomerAiReadToolsService {
  constructor(
    private readonly directorySearchService: StorefrontDirectorySearchService,
    private readonly menuItemSearchService: StorefrontMenuItemSearchService,
  ) {}

  async execute(
    call: CustomerAiToolCall,
    context: CustomerAiToolExecutionContext,
  ): Promise<CustomerAiToolExecutionResult> {
    // CustomerAiToolCall is a closed union validated before execution, so the
    // only non-restaurant branch is the menu-item tool.
    if (call.toolName === 'search_restaurants') {
      return this.searchRestaurants(call, context);
    }

    return this.searchMenuItems(call, context);
  }

  private async searchRestaurants(
    call: CustomerAiToolCall,
    context: CustomerAiToolExecutionContext,
  ): Promise<CustomerAiToolExecutionResult> {
    const args = normalizeSearchArguments(call.arguments, false);
    const response = await this.directorySearchService.search({
      q: args.q,
      city: args.city,
      state: args.state,
      country: args.country,
      lat: args.lat,
      lng: args.lng,
      radiusKm: args.radiusKm,
      page: 1,
      limit: args.limit,
    });
    const results = response.data.slice(0, args.limit).map((item, index) => {
      // Keep the full authoritative fact in process; send only the safe public
      // projection and its opaque ref back to the provider.
      const ref = opaqueRef(
        context.runId,
        context.sequence,
        index,
        'restaurant',
      );
      context.factsByRef.set(ref, toRestaurantFact(ref, item));

      return {
        ref,
        name: item.name,
        restaurantName: item.restaurantName,
        branchName: item.branchName ?? null,
        cuisines: item.cuisines.slice(0, 8),
        pickupEnabled: item.pickupEnabled,
        deliveryEnabled: item.deliveryEnabled,
        distanceKm: item.distanceKm,
      };
    });

    return {
      providerResult: {
        callId: call.callId,
        toolName: call.toolName,
        status: 'succeeded',
        output: { results, totalMatches: response.meta.total },
      },
      resultCardinality: results.length,
      returnedRefs: results.map((result) => result.ref),
    };
  }

  private async searchMenuItems(
    call: CustomerAiToolCall,
    context: CustomerAiToolExecutionContext,
  ): Promise<CustomerAiToolExecutionResult> {
    const args = normalizeSearchArguments(call.arguments, true);
    const response = await this.menuItemSearchService.search({
      q: args.q,
      city: args.city,
      state: args.state,
      country: args.country,
      lat: args.lat,
      lng: args.lng,
      radiusKm: args.radiusKm,
      fulfillmentType: args.fulfillmentType,
      includeUnavailable: false,
      page: 1,
      limit: args.limit,
    });
    const results = response.data.slice(0, args.limit).map((item, index) => {
      const ref = opaqueRef(context.runId, context.sequence, index, 'menu');
      context.factsByRef.set(ref, toMenuItemFact(ref, item));

      return {
        ref,
        name: item.name,
        description: item.description?.slice(0, 240) ?? null,
        priceMinorUnit: item.basePriceMinorUnit,
        currency: item.currency,
        orderable: item.availability.orderable && item.customization.orderable,
        restaurantName: item.restaurant.name,
        branchName: item.branch.name,
        pickupEnabled: item.branch.pickupEnabled,
        deliveryEnabled: item.branch.deliveryEnabled,
      };
    });

    return {
      providerResult: {
        callId: call.callId,
        toolName: call.toolName,
        status: 'succeeded',
        output: { results, totalMatches: response.meta.total },
      },
      resultCardinality: results.length,
      returnedRefs: results.map((result) => result.ref),
    };
  }
}

type NormalizedSearchArguments = {
  q?: string;
  city?: string;
  state?: string;
  country?: string;
  lat?: number;
  lng?: number;
  radiusKm?: number;
  fulfillmentType?: 'pickup' | 'delivery';
  limit: number;
};

function normalizeSearchArguments(
  input: Record<string, unknown>,
  allowFulfillmentType: boolean,
): NormalizedSearchArguments {
  // Reject unknown keys instead of silently accepting prompt-injected fields
  // that a future domain service might interpret differently.
  const allowedArguments = new Set([
    'q',
    'city',
    'state',
    'country',
    'lat',
    'lng',
    'radiusKm',
    'limit',
    ...(allowFulfillmentType ? ['fulfillmentType'] : []),
  ]);
  const unexpectedArgument = Object.keys(input).find(
    (key) => !allowedArguments.has(key),
  );
  if (unexpectedArgument) {
    throw new Error(`unexpected search argument: ${unexpectedArgument}`);
  }
  const lat = optionalBoundedNumber(input.lat, -90, 90, 'lat');
  // A single coordinate is meaningless and can lead to accidental broad
  // searches, so location is accepted only as a complete pair.
  const lng = optionalBoundedNumber(input.lng, -180, 180, 'lng');
  if ((lat === undefined) !== (lng === undefined)) {
    throw new Error('lat and lng must be provided together');
  }
  const fulfillmentType = optionalString(input.fulfillmentType, 20);
  if (
    fulfillmentType !== undefined &&
    fulfillmentType !== 'pickup' &&
    fulfillmentType !== 'delivery'
  ) {
    throw new Error('fulfillmentType must be pickup or delivery');
  }
  const requestedLimit =
    input.limit === undefined ? MAX_RESULTS : Number(input.limit);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
    throw new Error('limit must be a positive integer');
  }

  return {
    q: optionalString(input.q, 120),
    city: optionalString(input.city, 100),
    state: optionalString(input.state, 100),
    country: optionalString(input.country, 100),
    lat,
    lng,
    radiusKm: optionalBoundedNumber(input.radiusKm, 0.1, 100, 'radiusKm'),
    fulfillmentType,
    // The server cap applies even if a provider contract is bypassed or drifts.
    limit: Math.min(requestedLimit, MAX_RESULTS),
  };
}

function optionalString(value: unknown, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim().length > maxLength) {
    throw new Error('invalid string search argument');
  }

  return value.trim();
}

function optionalBoundedNumber(
  value: unknown,
  min: number,
  max: number,
  name: string,
): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${name} is outside its allowed range`);
  }

  return number;
}

function opaqueRef(
  runId: string,
  sequence: number,
  index: number,
  kind: string,
): string {
  // Deterministic within a run for auditability, but unrelated to domain IDs.
  return `ref_${createHash('sha256')
    .update(`${runId}:${sequence}:${index}:${kind}`)
    .digest('hex')
    .slice(0, 20)}`;
}

function toRestaurantFact(ref: string, item: StorefrontDirectorySearchResult) {
  return {
    kind: 'restaurant' as const,
    ref,
    name: item.name,
    restaurantName: item.restaurantName,
    branchName: item.branchName ?? null,
    cuisines: item.cuisines,
    pickupEnabled: item.pickupEnabled,
    deliveryEnabled: item.deliveryEnabled,
    distanceKm: item.distanceKm,
  };
}

function toMenuItemFact(ref: string, item: StorefrontMenuItemSearchResult) {
  return {
    kind: 'menu_item' as const,
    ref,
    name: item.name,
    description: item.description?.slice(0, 240) ?? null,
    priceMinorUnit: item.basePriceMinorUnit,
    currency: item.currency,
    orderable: item.availability.orderable && item.customization.orderable,
    restaurantName: item.restaurant.name,
    branchName: item.branch.name,
    pickupEnabled: item.branch.pickupEnabled,
    deliveryEnabled: item.branch.deliveryEnabled,
  };
}
