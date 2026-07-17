import { totalmem } from 'node:os';
import { HealthCheck, type HealthCheckInterface, type HealthCheckResult } from '@nitrostack/core';
import { PIPELINE_PEAK_RSS_MB, isYosysLoaded, sky130Lib } from '../lib/yosys.js';

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

      // Yosys-as-WASM peaks around 670MB. A host below that kills it mid-run with an opaque
      // WebAssembly error, so report the shortfall HERE rather than letting the first real tool
      // call be the thing that discovers it.
      const totalMb = Math.round(totalmem() / 1024 / 1024);
      const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
      const memoryTight = totalMb > 0 && totalMb < 1024;

      const details = {
        sky130Lib: `${libMb}MB`,
        yosysWasm: isYosysLoaded() ? 'loaded' : 'lazy (loads on first tool call)',
        verification: 'sat -prove-asserts (bounded model checking)',
        rssMB: rssMb,
        hostMemoryMB: totalMb,
        pipelinePeakMB: PIPELINE_PEAK_RSS_MB,
      };

      if (memoryTight) {
        return {
          status: 'degraded',
          message:
            `Host reports only ${totalMb}MB RAM, but the pipeline peaks near ${PIPELINE_PEAK_RSS_MB}MB ` +
            `(sky130 synthesis alone ~640MB). Yosys will abort with an opaque WebAssembly error. ` +
            `Give the deployment at least 1GB.`,
          details,
        };
      }

      return { status: 'up', message: 'EDA toolchain ready', details };
    } catch (e) {
      return {
        status: 'down',
        message: `EDA toolchain unavailable: ${(e as Error).message}`,
      };
    }
  }
}
