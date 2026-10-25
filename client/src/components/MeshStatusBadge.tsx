import { useEffect, useState } from "react";
import { fetchMeshConfig } from "../lib/meshClient";

export type MeshStatus = "off" | "ready" | "active" | "bridge" | "remote";

interface Props {
  /** Whether mesh is enabled relay-side (read from `/api/config`). */
  baseUrl?: string;
  /** Number of mesh peers our companion app has reported via relay. */
  activeMeshPeers?: number;
  /** Whether we've received a `mesh_peer_announce` from any of our devices. */
  remoteCompanionOnline?: boolean;
  /** Whether bridging is active (any of our devices is in bridge mode). */
  bridgeActive?: boolean;
  /** Inline style override — useful when slotting into the existing header. */
  className?: string;
}

/**
 * Compact mesh-status badge for the web client.
 *
 * Web is never a full mesh participant (no Web Bluetooth in Safari). The
 * badge therefore reflects two states:
 *   1. Relay says mesh is enabled (see `/api/config.mesh.enabled`).
 *   2. One of our other devices (Android / iOS) has announced its
 *      mesh presence through `mesh_peer_announce` — the web client can
 *      display "🌐 mesh via your phone" so the user knows their offline
 *      messages will hop through the companion.
 *
 * The component is intentionally self-contained: it polls
 * `fetchMeshConfig` once and otherwise listens to props so the parent
 * (currently `App.tsx`) can keep its own state shape unchanged.
 */
export function MeshStatusBadge(props: Props) {
  const {
    baseUrl,
    activeMeshPeers = 0,
    remoteCompanionOnline = false,
    bridgeActive = false,
    className,
  } = props;

  const [serverEnabled, setServerEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    if (!baseUrl) return;
    let cancelled = false;
    fetchMeshConfig(baseUrl).then(cfg => {
      if (!cancelled) setServerEnabled(Boolean(cfg?.enabled));
    });
    return () => {
      cancelled = true;
    };
  }, [baseUrl]);

  if (!serverEnabled) return null;
  if (!remoteCompanionOnline && activeMeshPeers === 0 && !bridgeActive) return null;

  const status: MeshStatus =
    bridgeActive ? "bridge" :
    remoteCompanionOnline ? "remote" :
    activeMeshPeers > 0 ? "active" : "ready";

  const label =
    status === "bridge" ? "🌐 bridge active"
    : status === "remote" ? "🌐 mesh via companion"
    : status === "active" ? `🌐 ${activeMeshPeers} nearby`
    : "🌐 mesh ready";

  const colour =
    status === "bridge" ? "rgba(120, 200, 255, 0.85)"
    : status === "active" || status === "remote" ? "rgba(140, 255, 175, 0.85)"
    : "rgba(180, 180, 180, 0.7)";

  return (
    <span
      className={`mesh-status-badge ${className ?? ""}`}
      title={`Mesh status: ${status}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 8px",
        marginLeft: 8,
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 500,
        color: colour,
        background: "rgba(255, 255, 255, 0.06)",
        border: "1px solid rgba(255, 255, 255, 0.08)",
      }}
    >
      {label}
    </span>
  );
}
