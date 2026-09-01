import type { TelemetryAttributes } from './types';

type QueryKey = readonly unknown[];

const isQueryKeyVersionSegment = (segment: string) => /^v\d+$/.test(segment);

const stringSegmentsFromQueryKey = (queryKey: QueryKey): string[] =>
  queryKey.filter(
    (segment): segment is string =>
      typeof segment === 'string' && !isQueryKeyVersionSegment(segment)
  );

const dynamicSegmentsFromQueryKey = (queryKey: QueryKey) =>
  queryKey.filter((segment) => typeof segment !== 'string');

export type OperationMetadata = {
  operationName: string;
  attributes: TelemetryAttributes;
};

export const deriveOperationMetadataFromKey = (
  queryKey: QueryKey,
  operationType: 'query' | 'mutation'
): OperationMetadata => {
  const stringSegments = stringSegmentsFromQueryKey(queryKey);
  const dynamicSegments = dynamicSegmentsFromQueryKey(queryKey);
  const operationName = stringSegments.length
    ? stringSegments.join('.')
    : `${operationType}.anonymous`;

  return {
    operationName,
    attributes: {
      'operation.name': operationName,
      'operation.type': operationType,
      'operation.key_static': stringSegments.join('.'),
      'operation.key_dynamic_count': dynamicSegments.length,
    },
  };
};
