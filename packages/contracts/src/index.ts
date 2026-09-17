/** Public wire DTOs. No native pi events or database rows cross this boundary. */
export interface ServiceStatus {
  service: 'parallel_pi';
  protocolVersion: 1;
  concurrency: number;
}
export interface ApiError {
  error: { code: string; message: string };
}
