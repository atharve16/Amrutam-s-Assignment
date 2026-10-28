export interface DatabaseConfig {
  url: string;
  ssl: boolean;
  poolMax: number;
  connectionTimeoutMs: number;
  idleTimeoutMs: number;
}
