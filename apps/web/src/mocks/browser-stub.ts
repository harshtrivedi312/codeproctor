export function setupWorker(): never {
  throw new Error('MSW browser worker is not available on the server');
}
