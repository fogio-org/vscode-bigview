/** Compilation and validation of every query kind (text search, time range, JSON field). */
import { compileQuery, isTextQuery, QueryError, type FieldQuery, type Query, type TimeRangeQuery } from '../shared/searchQuery';
import { parseFieldFilter, type FieldFilter } from './jsonlFormat';
import { parseTimeInput } from './logFormat';

export interface TimeRange {
  from: number | undefined;
  to: number | undefined;
}

export function compileTimeRange(q: TimeRangeQuery, defaultYear?: number): TimeRange {
  const from = parseTimeInput(q.from, 'from', defaultYear);
  const to = parseTimeInput(q.to, 'to', defaultYear);
  if (from === undefined && to === undefined) throw new QueryError('Enter a start time, an end time, or both');
  if (from !== undefined && to !== undefined && from > to) throw new QueryError('The start time is after the end time');
  return { from, to };
}

export function compileFieldQuery(q: FieldQuery): FieldFilter {
  return parseFieldFilter(q.expression);
}

/** Throws QueryError for an invalid query; returns the regex that highlights a text query. */
export function validateQuery(q: Query): RegExp | undefined {
  if (isTextQuery(q)) return compileQuery(q).regex;
  if (q.kind === 'time') compileTimeRange(q);
  else compileFieldQuery(q);
  return undefined;
}
