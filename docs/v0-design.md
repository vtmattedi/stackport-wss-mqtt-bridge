# v0 design — Stackport live-status to MQTT

Status: **design frozen for implementation review; not yet implemented or deployed**.

## Goal and boundaries

One small always-on adapter turns the `/status/ws` stream from a single Stackport instance into **read-only retained operational state** on the existing [Stackport-Mqtt](https://github.com/vtmattedi/Stackport-mqtt) Mosquitto broker.

This is **state mirroring, not event delivery**. There are no guarantees of observing every intermediate deploy transition. Stackport's live-status endpoint provides a full snapshot upon every connection, then **complete section replacements**, not patches.

V0 does not expose an HTTP server, commands, a UI, a database, or a Docker socket. It is **not part of MW Notification** and does not depend on that service being online.

## Architecture

```text
Stackport 1.3.11+ (public WSS)           Stackport-Mqtt / Mosquitto
  wss://sp.mattediworks.com/status/ws      mqtts://mqtt.mattediworks.com:8883
  Authorization: Bearer spk_...                   dedicated service client
            |                                              ^
            | wss://sp.mattediworks.com/status/ws         | TLS CA + verify_hostname
            v                                              |
  ┌─────────────────────────────────────────────────────────────┐
  │                  Bun / TypeScript bridge                    │
  │  source state machine → latest sections → publish coalescer│
  │                    bounded memory, no DB                   │
  └─────────────────────────────────────────────────────────────┘
                (no listening ports; outbound only)
```

**Libraries:** Bun native `WebSocket` with custom `Authorization` header; MQTT.js (Node TLS-compatible client). Avoid Socket.IO because this endpoint is not Socket.IO. Bun + MQTT.js must pass a real MQTTS/reconnect soak test before considering v0 production-ready; **Node.js LTS with `ws` + MQTT.js** is the fallback if Bun interop fails.

## Source wire contract (Stackport PR #41, merged)

Use `GET /status/ws` with `Authorization: Bearer <status-scope-token>`. No URL query string, no `Origin` header, no outbound application frames; WebSocket protocol ping/pong is handled by the runtime.

| Received frame | Required behavior |
| --- | --- |
| `hello` | Require `v:1`, exact `instance === SP_INSTANCE`, expected `scope`, and four known sections. Do not publish source online. |
| `snapshot` | Require `v:1` and integer `seq`; replace the entire local four-section state; stage a **full** retained republish. This is the first valid data after every connect. |
| `update` | Require next integer `seq`, one of `host/projects/actions/alerts`; replace **that entire section**, never merge arrays. |
| `heartbeat` | Require next integer `seq`; observe `dataAgeS` (age of collected state), not just connection liveness. |
| Close/error | Set `status.state=offline` with a source failure reason (if broker online); leave the retained state sections unchanged, reconnect. |

A snapshot's `seq` and subsequent frames are **per connection** and reset on reconnect. If a sequence gap, unsupported `v`, invalid section/payload, or unexpected snapshot/update ordering occurs, **close the stream and reconnect for a full snapshot**. Validate expected message size and high-level shapes; never deserialize unbounded input.

The source refreshes approximately every 10 seconds with a heartbeat every 30 seconds. A heartbeat containing `dataAgeS > 90` means the source is **stale** even though the socket is still open. A missing frame for >90 seconds triggers reconnect. Both thresholds can be tuned later.

Source sections (use Stackport's field names and types unchanged, preserving its stable integer project `id`):

```ts
type Snapshot = {
  host: HostStatus | null;
  projects: ProjectStatus[];
  actions: ActionStatus[];
  alerts: Alert[];
};
```

Only use the authoritative Stackport payload; **never fabricate `down` statuses** when the transport fails.

## MQTT topic contract

`<instance>` is exactly the configured `SP_INSTANCE` and the instance provided by Stackport's `hello` (e.g. `sp-11aa22bb33`). It is **fixed before MQTT CONNECT** so Last Will topics are deterministic.

| Topic | Retain | QoS | Value |
| --- | --- | --- | --- |
| `stackport/<instance>/status` | true | 1 | unified source and bridge health; MQTT Last Will marks bridge offline |
| `stackport/<instance>/state/host` | true | 1 | exactly the `host` JSON object or `null` |
| `stackport/<instance>/state/projects` | true | 1 | complete `projects` JSON array |
| `stackport/<instance>/state/actions` | true | 1 | complete `actions` JSON array |
| `stackport/<instance>/state/alerts` | true | 1 | complete `alerts` JSON array |

**Migration:** before publishing the unified status on each MQTT connection, delete old `bridge/availability` and `source/availability` retained records with QoS 1 zero-byte publications. The publish-only ACL covers these legacy paths. Consumers must switch before upgrading and exactly one bridge may write this prefix.

*No per-project retained topics for v0.* Because an entire array replaces the last one, deleted projects, finished actions, and cleared alerts disappear from the next retained array **without tombstones, broker subscriptions, or any persistent manifest**. Array order is not meaningful. An empty section is **`[]`**, not an empty MQTT payload (which clears a retained topic).

Availability payload example:

```json
{
  "state": "online",
  "observedAt": "2026-11-12T12:00:00.000Z",
  "snapshotAt": "2026-11-12T12:00:00.000Z",
  "reason": null
}
```

`state`: `connecting` (no fully synchronized snapshot), `online` (synchronized and healthy source), `stale` (WebSocket open but `dataAgeS` exceeds threshold), or `offline` (source failure or MQTT Last Will). `snapshotAt` is the timestamp of the last complete Stackport snapshot, not a continuously updated last-message time. `observedAt` records the health transition. Status is emitted on health changes and snapshot synchronization, not timestamp-only heartbeats or updates. `reason` uses bounded codes such as `socket_closed`, `timeout`, `stale_data`, `bad_protocol`, or `bridge_disconnected` for the LWT.

**Consumers inspect only `status`.** When it is not `online`, treat the retained four state sections as last-known. The MQTT Last Will payload is `{"state":"offline","reason":"bridge_disconnected"}` without timestamps because the broker cannot know the disconnection time.

Only the bridge may write this namespace. A separate read-only role for subscribing dashboard/NMNW consumers is outside this service's responsibilities.

## Ordering and reconnection state machine

### Startup

1. Validate `.env` and certificate; reject all query strings in the Stackport URL; require `SP_INSTANCE` to be a single safe topic segment, `mqtts:` scheme, valid TLS hostname, and nonempty service credentials.
2. Connect **`mqtts://mqtt.mattediworks.com:8883`** with a stable unique `clientId`, `keepalive` 30 seconds, QoS1 retained Last Will `status={"state":"offline","reason":"bridge_disconnected"}`, and TLS verification using the NM Root CA and the configured certificate name.
3. On MQTT CONNACK, delete both legacy retained availability topics before publishing `status=connecting` or `offline` according to the actual source state.
4. Open **`wss://sp.mattediworks.com/status/ws`** with only `Authorization: Bearer <SP_STATUS_TOKEN>` and valid public TLS; expect `hello` and `snapshot`.
5. **On every new snapshot**, set a fresh local four-section state, mark all four topics dirty and publish them with QoS1; publish `status.state=online` **only after all four current section publications are acknowledged**.

### Updates

- On `update`, replace the relevant section in memory. If the normalized JSON differs from the last successfully acknowledged value, schedule a retained QoS1 publish of **that section only**.
- Serialize writes through one bounded/coalescing publisher. While a QoS1 publish awaits PUBACK, keep only the latest value for each of the four sections; if an update arrives, publish the latest next. Avoid unbounded queued MQTT.js offline QoS1 messages.
- Treat a PUBACK as successful publication. Do not mark the local section clean before PUBACK; on error/disconnect, mark it dirty again.
- Heartbeats drive source staleness detection in memory but **do not publish MQTT status or state**. Status publishes on health changes or new snapshot synchronization, not timestamp-only changes.
- Do not publish raw event frames or append notification history.

### Stackport reconnect

- Immediately mark `status.state=offline` with a source failure reason (if broker connected). Preserve last retained sections and do not replace them with defaults.
- Reconnect with capped exponential backoff and jitter, then require a new full snapshot. All four topics are reconciled, including `[]` for deleted/cleared arrays. The new `seq` starts a new connection epoch.

### MQTT disconnect / broker restart

- MQTT Last Will marks bridge unavailable when it detects the lost connection. The bridge keeps up to four latest source section values **in memory** while MQTT is disconnected.
- Do **not** queue every intermediate update. On reconnect, mark all four sections dirty; if a current full source snapshot exists, republish all four retained sections with PUBACK, then publish unified status as online. If source is disconnected, publish unified status offline and keep old data without presenting it as fresh.
- Reassert bridge availability on MQTT reconnection. MQTT.js reconnects, with error handling that does not leak secrets.

### Process restart

- Retained MQTT sections survive a bridge restart due to Mosquitto persistence. The new bridge does **not** try to infer freshness from retained data. Unified status remains connecting until a fresh complete snapshot is received and republished. On lost broker connectivity the MQTT Last Will marks it offline.
- There is no local DB. A single bridge instance is permitted for each Stackport instance/topic prefix; two live writers on the same prefix are unsupported.

## Security model

- `SP_STATUS_TOKEN` has **status-only** scope and no MCP read/write access. V0 expects **all** scope; group-scoped operation is deferred pending [ENG-65](https://linear.app/mattediworks/issue/ENG-65/p1-reconcile-scoped-live-status-sections-when-a-project-changes-groups).
- `MQTT_USERNAME`/`MQTT_PASSWORD` belong to a dedicated Mosquitto Dynamic Security client with **publishClientSend only** on `stackport/<instance>/#`. Not `mqtt-admin`, not `nmnw`, no `$CONTROL`, no subscribe access.
- Keep credentials only in an untracked private `.env` or host secret store. The NM public CA is committed; **never commit a private CA key, broker key, or client credential**.
- MQTT is always authenticated `mqtts` on 8883, with CA and hostname verification. `MQTT_TLS_SERVERNAME=mqtt.mattediworks.com` is fixed for the external v0 endpoint; it must match the broker certificate SAN.
- No inbound ports, no Docker socket, no root privileges, no privileged container, no shell/deploy privileges.
- Sanitize logs: never print tokens, passwords, full connection URL userinfo, provider payload, or raw WebSocket errors that may contain headers. Structured telemetry: connection state, last source frame, source age, publish success/failure counts, retry backoff.
- Maximum inbound frame size / JSON depth and outgoing MQTT payload size must be bounded with explicit caps. Failure to parse closes/reconnects instead of publishing corrupt state.
- v0 always uses externally verified **`wss://sp.mattediworks.com/status/ws`** and **`mqtts://mqtt.mattediworks.com:8883`**. It does not require an internal container route or host loopback. **Do not** weaken Stackport's TLS/loopback policy.

## Acceptance tests (implementation phase)

1. **Protocol**: authenticates via header, rejects wrong instance, unsupported version, unknown section, pre-snapshot update, out-of-order `seq`, oversized/malformed JSON; reconnects for fresh snapshot.
2. **Snapshot**: on initial snapshot publishes exactly four retained states, with original integer project IDs, plus unified status. PUBACK must precede marking state synchronized.
3. **Updates**: a single `projects` update only changes `state/projects`; unchanged data and heartbeat do not produce repeated state publications. Empty arrays replace existing retained arrays.
4. **Failures**: source disconnect/stale/timeout does not mark projects down; broker disconnect triggers bridge LWT and recovery republishes latest complete state with no backlog.
5. **Security**: invalid status token cannot connect; no `Origin` or token query string; MQTT rejects untrusted TLS, wrong servername, wrong password and forbidden topic; no client listening ports.
6. **Convergence**: restart bridge, MQTT, or Stackport independently; newly subscribed MQTT clients see the latest retained section arrays plus truthful availability.
7. **Real deployment**: verify Stackport's external **Nginx/WSS** route, external broker MQTTS TCP proxy and NM Root CA chain from the bridge container. See [ENG-66](https://linear.app/mattediworks/issue/ENG-66/p1-validate-secure-internal-route-for-stackport-live-ws-mqtt-bridge).

No claim of v0 production-readiness until these tests pass against a real bridge and broker.

## Deliberately deferred

- Per-project/per-alert topics, deletions/tombstone manifest, or broker subscriptions.
- Event stream, durable queue, and replay; if events are required later, define new non-retained topics and durability semantics separately.
- Multitenancy/multiple Stackport instances in a process.
- MQTT commands routed back into Stackport.
- Automatic MQTT ACL provisioning or broker admin API access.
- Any HTTP health endpoint or dashboard UI. A watchdog can use the process exit code and retained unified status.
