import { totalmem } from 'node:os';
import { HealthCheck, HealthCheckInterface, HealthCheckResult } from '@nitrostack/core';

/**
 * System Health Check
 * 
 * Monitors system resources and uptime
 */
@HealthCheck({ 
  name: 'system', 
  description: 'System resource and uptime check',
  interval: 30 // Check every 30 seconds
})
export class SystemHealthCheck implements HealthCheckInterface {
  private startTime: number;

  constructor() {
    this.startTime = Date.now();
  }

  async check(): Promise<HealthCheckResult> {
    try {
      const memoryUsage = process.memoryUsage();
      const uptimeSeconds = Math.floor((Date.now() - this.startTime) / 1000);

      // Measure RSS against the HOST's memory.
      //
      // The starter compared heapUsed/heapTotal and called >90% "High memory usage detected".
      // That ratio is meaningless: V8 keeps heapTotal just above heapUsed and grows it on demand,
      // so a perfectly healthy process sits at ~92% forever. This server therefore reported
      // "degraded" permanently — and NitroCloud surfaced that as **Unhealthy** while RSS was 76MB
      // of 3.8GB. A health check that is always red tells you nothing.
      const rssMB = Math.round(memoryUsage.rss / 1024 / 1024);
      const hostMB = Math.round(totalmem() / 1024 / 1024);
      const usedPercent = hostMB > 0 ? (rssMB / hostMB) * 100 : 0;

      // Yosys-as-WASM spikes to ~670MB mid-run, so a high transient RSS is expected and normal.
      // Only flag a host that genuinely cannot fit the pipeline.
      const healthy = hostMB === 0 || usedPercent < 90;

      return {
        status: healthy ? 'up' : 'degraded',
        message: healthy ? 'System is healthy' : `High memory usage: ${rssMB}MB of ${hostMB}MB`,
        details: {
          uptime: `${uptimeSeconds}s`,
          memory: `${rssMB}MB RSS / ${hostMB}MB host (${Math.round(usedPercent)}%)`,
          heap: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB`,
          pid: process.pid,
          nodeVersion: process.version,
        },
      };
    } catch (error: any) {
      return {
        status: 'down',
        message: 'System health check failed',
        details: error.message,
      };
    }
  }
}

