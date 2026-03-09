/**
 * Text and conversation chunking utilities.
 *
 * Generic array chunking with configurable window size and overlap,
 * used by both semantic and graph extraction pipelines.
 */

const DEFAULT_CHUNK_SIZE = 25;
const DEFAULT_CHUNK_OVERLAP = 5;
const DEFAULT_MAX_TURNS = 100;

/**
 * Split an array into processable chunks with overlap.
 *
 * If the array fits within maxTurns, returns a single chunk.
 * Otherwise, splits into windows of chunkSize with overlap to preserve
 * context across chunk boundaries. Original item ordering is preserved.
 */
export function chunkConversation<T>(
  exchanges: T[],
  chunkSize: number = DEFAULT_CHUNK_SIZE,
  overlap: number = DEFAULT_CHUNK_OVERLAP,
): T[][] {
  if (exchanges.length <= DEFAULT_MAX_TURNS) {
    return [exchanges];
  }

  const chunks: T[][] = [];
  let start = 0;

  while (start < exchanges.length) {
    const end = Math.min(start + chunkSize, exchanges.length);
    chunks.push(exchanges.slice(start, end));

    // Advance by chunkSize minus overlap, but at least 1 to avoid infinite loop
    const step = Math.max(chunkSize - overlap, 1);
    start += step;

    // If the remaining exchanges would be smaller than overlap, include them
    // in the last chunk and stop
    if (start < exchanges.length && exchanges.length - start <= overlap) {
      chunks.push(exchanges.slice(start));
      break;
    }
  }

  return chunks;
}
