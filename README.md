# Stackport WSS → MQTT Bridge

A small, **receive-only Stackport live-status → MQTT state bridge**.

**Stage:** v0 architecture/implementation plan. This repository deliberately starts with the contract and deployment decisions; it is **not yet a runnable service**.

## Purpose

Keep Stackport's current operational state available to MQTT clients through the existing [Stackport-Mqtt](https://github.com/vtmattedi/Stackport-mqtt) broker. The source is [Stackport's live-status WebSocket](https://github.com/vtmattedi/Stackport/blob/main/docs/1.3.11/live-status.md) (`/status/ws`, introduced in Stackport PR #41), **not** its privileged Socket.IO API.

- Host metrics, project states, running actions and currently active alerts.
- On connection, publish a complete snapshot.
- Afterwards, republish only a changed **section**.
- Retain the most recent state in MQTT for clients connecting later.
- When Stackport becomes unreachable or stale, publish source availability separately; **do not turn every project into “down.”**

## Proposed v0 stack

- **Bun + TypeScript**, using the **Bun native WebSocket client** with an Authorization header.
- **MQTT.js** over authenticated **MQTTS / TLS on port 8883**. No separate broker, HTTP server, Socket.IO client, database, or incoming port.
- Two upstream service credentials, configured in a private `.env`: `SP_STATUS_TOKEN` (Stackport `status` scope) and `MQTT_USERNAME`/`MQTT_PASSWORD` (dedicated Mosquitto Dynamic Security client).
- TLS verification for MQTT against [`certs/nm-root-ca.crt`](certs/nm-root-ca.crt). **Never use `rejectUnauthorized: false`.** The supplied NM Root CA is public trust material, **not** an application secret; its fingerprint is recorded in the security document.
- MQTT QoS 1 and retained publications; broker Last Will for bridge process availability.
- **No subscriptions** and **no per-project retained topics** in v0: each section is one retained JSON topic. This avoids stale per-project topics and the need for a durable deleted-ID registry.

## MQTT topics

Given a fixed `SP_INSTANCE=sp-...` (from Stackport's Settings → Live status):

| Topic | Retained payload |
| --- | --- |
| `stackport/<instance>/bridge/availability` | `{"state":"online"}` or LWT `{"state":"offline"}` |
| `stackport/<instance>/source/availability` | JSON state: `connecting`, `online`, `stale`, or `offline`, plus timestamps/data age |
| `stackport/<instance>/state/host` | Entire Stackport `host` section (object or JSON `null`) |
| `stackport/<instance>/state/projects` | Entire `projects` array, retaining Stackport's stable integer project `id` |
| `stackport/<instance>/state/actions` | Entire `actions` array |
| `stackport/<instance>/state/alerts` | Entire `alerts` array (conditions, **not** notification history) |

All JSON is UTF-8. State messages are published with `qos: 1`, `retain: true`. An empty array is **`[]`**, not an MQTT retained-message deletion. MQTT clients may receive duplicates: process state idempotently.

## Files

- [`docs/v0-design.md`](docs/v0-design.md) — contract, algorithm, failure semantics, tests, rollout.
- [`docs/deployment.md`](docs/deployment.md) — internal/local networking and alternatives, broker ACL, env setup.
- [`certs/nm-root-ca.crt`](certs/nm-root-ca.crt) — public broker CA supplied for this deployment.
- [`.env.example`](.env.example) — example configuration, **no credentials**.

## Key dependencies / limits

1. Enable **Settings → Live status** in Stackport and create a **status-only** token (not a session or MCP read/write token).
2. Provision a dedicated **publish-only** client in Stackport-Mqtt's Dynamic Security ACL for `stackport/<instance>/#`. No `mqtt-admin` or broad `nmnw` role.
3. Choose a network path satisfying Stackport's security rule: **direct unproxied host-loopback `ws://127.0.0.1:3000/status/ws`**, or a properly verified **`wss://`** route. Cleartext cross-container `ws://stackport:3000` will be rejected.
4. Broker may be reached on localhost or over an internal Docker network, but its TLS server certificate must still verify against `mqtt.mattediworks.com` (use TLS `servername` when connecting to an IP).
5. Existing [Linear ENG-65](https://linear.app/mattediworks/issue/ENG-65/p1-reconcile-scoped-live-status-sections-when-a-project-changes-groups) and [ENG-66](https://linear.app/mattediworks/issue/ENG-66/p1-validate-secure-internal-route-for-stackport-live-ws-mqtt-bridge) track scoped stream correctness and secure deployment topology.

**Out of scope for v0:** per-project topics, event history/replay, remote control, MQTT subscriptions, per-user configuration, UI, and general-purpose notification dispatch.
