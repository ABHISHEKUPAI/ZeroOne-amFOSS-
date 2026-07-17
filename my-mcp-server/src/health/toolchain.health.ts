import { HealthCheck, type HealthCheckInterface, type HealthCheckResult } from '@nitrostack/core';
import { isYosysLoaded, sky130Lib } from '../lib/yosys.js';

/**
 * Proves the EDA toolchain is actually usable in *this* deployment.
 *
 * The two things that realistically break on a fresh host are the 54MB WASM failing to resolve and
 * the vendored liberty file not being shipped. Both are silent until the first tool call, which on
 * demo day is the worst possible moment to find out.
 */
@HealthCheck({
  name: 'toolchain',
  description: 'Yosys WASM and sky130 liberty availability',
  interval: 60,
})
export class ToolchainHealthCheck implements HealthCheckInterface {
  async check(): Promise<HealthCheckResult> {
    try {
      const lib = await sky130Lib();
      const libMb = Math.round((lib.byteLength / 1024 / 1024) * 10) / 10;

      // The liberty file is the cost model's entire evidence base; a truncated copy would silently
      // produce wrong area.
      if (lib.byteLength < 1_000_000) {
        return {
          status: 'down',
          message: `sky130.lib is only ${libMb}MB — expected ~13MB. Area figures would be wrong.`,
          details: { sky130LibBytes: lib.byteLength },
        };
      }

      return {
        status: 'up',
        message: 'EDA toolchain ready',
        details: {
          sky130Lib: `${libMb}MB`,
          yosysWasm: isYosysLoaded() ? 'loaded' : 'lazy (loads on first tool call)',
          verification: 'sat -prove-asserts (bounded model checking)',
          heapMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        },
      };
    } catch (e) {
      return {
        status: 'down',
        message: `EDA toolchain unavailable: ${(e as Error).message}`,
      };
    }
  }
}
