/**
 * Service configuration from environment variables with sensible defaults.
 */

export interface ServiceConfig {
  port: number;
  dbPath: string;
  rateLimit: {
    maxPerHour: number;
  };
  maxPayloadBytes: number;
  badgeCacheMaxAge: number;
}

export function loadConfig(): ServiceConfig {
  return {
    port: Number(process.env.PORT) || 8080,
    dbPath: process.env.DB_PATH || "./data/selftune.db",
    rateLimit: {
      maxPerHour: Number(process.env.RATE_LIMIT_PER_HOUR) || 10,
    },
    maxPayloadBytes: Number(process.env.MAX_PAYLOAD_BYTES) || 512 * 1024,
    badgeCacheMaxAge: Number(process.env.BADGE_CACHE_MAX_AGE) || 300,
  };
}
