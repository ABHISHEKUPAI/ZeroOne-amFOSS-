'use client';

/**
 * The engineering report, rendered inline in whatever client called the tool.
 *
 * This is shared by every EDA tool, so it must render a PARTIAL design gracefully: after write_rtl
 * there is no cost, after simulate there is no area. Missing stages render as "not run" — never as
 * a zero or a dash that could be mistaken for a measurement.
 */

import React from 'react';
import { useWidgetSDK } from '@nitrostack/widgets';

type Assertion = {
  cell: string;
  src: string | null;
  status: 'proved' | 'failed';
  failedAtStep: number | null;
};

type Util = { resource: string; used: number; available: number; percent: number };

interface Design {
  spec: string;
  target: string;
  top: string | null;
  verified: boolean | null;
  assertions: Assertion[] | null;
  area_um2: number | null;
  cell_count: number | null;
  utilization: Util[] | null;
  fmax_mhz: number | null;
  cost_eur: number | null;
  tiles: number | null;
  history: Array<{ at: string; tool: string; ok: boolean; summary: string }>;
}

interface ToolOutput {
  ok?: boolean;
  design_id?: string;
  report?: string;
  design?: Design;
  // Present on the individual EDA tools rather than design_report.
  assertions?: Assertion[];
  area_um2?: number | null;
  cost_eur?: number;
  next_step?: string;
  counterexample?: string[];
}

const C = {
  bg: 'var(--nitro-bg, transparent)',
  fg: 'var(--nitro-fg, #1a1a1a)',
  muted: '#6b7280',
  line: 'rgba(128,128,128,0.22)',
  ok: '#16a34a',
  bad: '#dc2626',
  warn: '#d97706',
  accent: '#4f46e5',
};

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  tone?: string;
}) {
  return (
    <div
      style={{
        border: `1px solid ${C.line}`,
        borderRadius: 10,
        padding: '12px 14px',
        minWidth: 0,
        flex: '1 1 140px',
      }}
    >
      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.06em', color: C.muted }}>
        {label}
      </div>
      <div
        style={{
          fontSize: 22,
          fontWeight: 650,
          marginTop: 4,
          color: tone ?? C.fg,
          fontVariantNumeric: 'tabular-nums',
          wordBreak: 'break-word',
        }}
      >
        {value}
      </div>
      {sub && <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

/** A stage that never ran must look unmistakably different from a measured zero. */
const NotRun = () => <span style={{ color: C.muted, fontWeight: 400, fontSize: 15 }}>not run</span>;

function Bar({ pct, tone }: { pct: number; tone: string }) {
  return (
    <div style={{ background: C.line, borderRadius: 4, height: 6, overflow: 'hidden', minWidth: 60 }}>
      <div style={{ width: `${Math.min(100, Math.max(pct, pct > 0 ? 1.5 : 0))}%`, height: '100%', background: tone }} />
    </div>
  );
}

export default function DesignReportWidget() {
  const { isReady, getToolOutput } = useWidgetSDK();
  const out = getToolOutput<ToolOutput>();

  if (!isReady) return <div style={{ padding: 16, color: C.muted }}>Connecting…</div>;
  if (!out) return <div style={{ padding: 16, color: C.muted }}>No design data received.</div>;

  const d = out.design;
  const assertions = d?.assertions ?? out.assertions ?? null;
  const proved = assertions?.filter((a) => a.status === 'proved').length ?? 0;
  const total = assertions?.length ?? 0;

  // Verified only when a proof ran AND actually proved something. Zero assertions is vacuous.
  const verified = d?.verified ?? (out.assertions ? out.ok === true : null);
  const verdictTone = verified === true ? C.ok : verified === false ? C.bad : C.muted;

  const area = d?.area_um2 ?? out.area_um2 ?? null;
  const cost = d?.cost_eur ?? out.cost_eur ?? null;

  return (
    <div
      style={{
        fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif',
        color: C.fg,
        background: C.bg,
        padding: 16,
        lineHeight: 1.5,
      }}
    >
      {/* header */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: C.accent, fontWeight: 700 }}>
          ⚡ Silicon Architect
        </div>
        <h1 style={{ fontSize: 19, margin: '4px 0 2px', fontWeight: 680 }}>
          {d?.spec ?? 'Engineering report'}
        </h1>
        <div style={{ fontSize: 12, color: C.muted }}>
          {out.design_id && <code>{out.design_id}</code>}
          {d?.top && <> · top <code>{d.top}</code></>}
          {d?.target && <> · target <code>{d.target}</code></>}
        </div>
      </div>

      {/* verdict */}
      <div
        style={{
          border: `1px solid ${verdictTone}44`,
          background: `${verdictTone}0f`,
          borderRadius: 10,
          padding: '10px 14px',
          marginBottom: 14,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <span style={{ fontSize: 18 }}>{verified === true ? '✅' : verified === false ? '❌' : '⬜'}</span>
        <div>
          <div style={{ fontWeight: 650, color: verdictTone }}>
            {verified === true
              ? `Formally verified — ${proved}/${total} assertion${total === 1 ? '' : 's'} proved`
              : verified === false
                ? total
                  ? `Verification failed — ${total - proved}/${total} assertion${total === 1 ? '' : 's'} violated`
                  : 'Verification failed'
                : 'Not yet verified'}
          </div>
          <div style={{ fontSize: 11.5, color: C.muted }}>
            Bounded model checking (Yosys <code>sat -prove-asserts</code>) — proved against all inputs, not simulated.
          </div>
        </div>
      </div>

      {/* stats */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
        <Stat
          label="Cell area"
          value={area != null ? `${area.toLocaleString(undefined, { maximumFractionDigits: 1 })}` : <NotRun />}
          sub={area != null ? 'µm² · real sky130 cells' : 'needs synthesize(sky130)'}
        />
        <Stat
          label="Cells"
          value={d?.cell_count != null ? d.cell_count.toLocaleString() : <NotRun />}
          sub={d?.cell_count != null ? 'post-synthesis' : undefined}
        />
        <Stat
          label="Fmax"
          value={d?.fmax_mhz != null ? `${d.fmax_mhz.toFixed(1)}` : <NotRun />}
          sub={d?.fmax_mhz != null ? 'MHz · achieved (nextpnr)' : 'needs place_and_route (ecp5)'}
        />
        <Stat
          label="Cost"
          value={cost != null ? `€${cost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : <NotRun />}
          sub={cost != null ? `IHP MPW${d?.tiles ? ` · ${d.tiles} TT tile${d.tiles === 1 ? '' : 's'}` : ''}` : 'needs cost_sheet'}
          tone={cost != null ? C.accent : undefined}
        />
      </div>

      {/* assertions */}
      {assertions && assertions.length > 0 && (
        <section style={{ marginBottom: 14 }}>
          <h2 style={{ fontSize: 13, fontWeight: 650, margin: '0 0 6px' }}>
            Assertions <span style={{ color: C.muted, fontWeight: 400 }}>({proved}/{total} proved)</span>
          </h2>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: C.muted }}>
                  <th style={{ padding: '4px 8px 4px 0', fontWeight: 500 }}>Assertion</th>
                  <th style={{ padding: '4px 8px', fontWeight: 500 }}>Source</th>
                  <th style={{ padding: '4px 8px', fontWeight: 500 }}>Result</th>
                </tr>
              </thead>
              <tbody>
                {assertions.map((a) => (
                  <tr key={a.cell} style={{ borderTop: `1px solid ${C.line}` }}>
                    <td style={{ padding: '5px 8px 5px 0' }}>
                      <code style={{ fontSize: 11.5 }}>{a.cell}</code>
                    </td>
                    <td style={{ padding: '5px 8px', color: C.muted }}>
                      <code style={{ fontSize: 11.5 }}>{a.src ?? '—'}</code>
                    </td>
                    <td
                      style={{
                        padding: '5px 8px',
                        color: a.status === 'proved' ? C.ok : C.bad,
                        fontWeight: 600,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {a.status === 'proved'
                        ? '✅ proved'
                        : `❌ failed${a.failedAtStep != null ? ` @ cycle ${a.failedAtStep}` : ''}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* counterexample */}
      {out.counterexample && out.counterexample.length > 0 && (
        <section style={{ marginBottom: 14 }}>
          <h2 style={{ fontSize: 13, fontWeight: 650, margin: '0 0 6px', color: C.bad }}>Counterexample</h2>
          <pre
            style={{
              margin: 0,
              padding: 10,
              border: `1px solid ${C.line}`,
              borderRadius: 8,
              fontSize: 11,
              overflowX: 'auto',
              maxHeight: 200,
              background: 'rgba(220,38,38,0.05)',
            }}
          >
            {out.counterexample.slice(0, 20).join('\n')}
          </pre>
        </section>
      )}

      {/* utilization */}
      {d?.utilization && d.utilization.length > 0 && (
        <section style={{ marginBottom: 14 }}>
          <h2 style={{ fontSize: 13, fontWeight: 650, margin: '0 0 6px' }}>Part fit</h2>
          {d.utilization.map((u) => (
            <div
              key={u.resource}
              style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, padding: '3px 0' }}
            >
              <div style={{ width: 68, color: C.muted }}>{u.resource}</div>
              <div style={{ flex: 1, maxWidth: 200 }}>
                <Bar pct={u.percent} tone={u.percent > 90 ? C.bad : u.percent > 70 ? C.warn : C.ok} />
              </div>
              <div style={{ fontVariantNumeric: 'tabular-nums', color: C.muted }}>
                {u.used.toLocaleString()} / {u.available.toLocaleString()} ({u.percent < 0.01 ? '<0.01' : u.percent.toFixed(2)}%)
              </div>
            </div>
          ))}
        </section>
      )}

      {/* next step — this is the control-plane hint the model acts on */}
      {out.next_step && (
        <div
          style={{
            border: `1px solid ${C.line}`,
            borderLeft: `3px solid ${C.accent}`,
            borderRadius: 6,
            padding: '8px 12px',
            fontSize: 12.5,
            color: C.muted,
            marginBottom: 14,
          }}
        >
          <strong style={{ color: C.fg }}>Next:</strong> {out.next_step}
        </div>
      )}

      {/* full report */}
      {out.report && (
        <details>
          <summary style={{ cursor: 'pointer', fontSize: 12.5, color: C.accent, fontWeight: 600 }}>
            Full engineering report
          </summary>
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontSize: 11.5,
              lineHeight: 1.55,
              marginTop: 8,
              padding: 12,
              border: `1px solid ${C.line}`,
              borderRadius: 8,
              maxHeight: 460,
              overflowY: 'auto',
            }}
          >
            {out.report}
          </pre>
        </details>
      )}

      <div style={{ marginTop: 12, fontSize: 10.5, color: C.muted, borderTop: `1px solid ${C.line}`, paddingTop: 8 }}>
        Every figure produced by a real EDA run (Yosys 0.64 / nextpnr, WASM, in-process). Stages that
        did not run are marked “not run” and are never estimated.
      </div>
    </div>
  );
}
