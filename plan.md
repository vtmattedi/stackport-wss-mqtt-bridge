# Implementation plan — v0 Stackport live status → MQTT

Status: **design approved? not yet**. The architecture and topic contract are specified in [docs/v0-design.md](docs/v0-design.md), with deployment assumptions in [docs/deployment.md](docs/deployment.md).

Do **not** call the bridge deployable until all acceptance tests and the real VPS integration gate pass. No backwards compatibility to a previous bridge implementation is required; this is a new service.

## Phase 0 — Runtime and transport spike

- [ ] Initialize Bun/TypeScript project with strict TypeScript, pinned package versions, lockfile and a multi-stage, unprivileged production image.
- [ ] Verify **Bun native WebSocket** can send the required `Authorization` header to a local Stackport `/status/ws` test server, with no `Origin` header and no outgoing data frames.
- [ ] Verify MQTT.js runs correctly in the selected Bun version: TLS custom CA, `servername`, username/password, QoS1 `publish` callback / PUBACK, Last Will, retained messages, connection timeout, broker restart, offline buffer behavior.
- [ ] Record compatibility/soak results. If MQTT.js/Bun interop is unreliable, use **Node LTS + ws + MQTT.js**; do not disable TLS verification.
- [ ] Fail fast on missing/invalid configuration; do not log secrets.

**Exit:** one reliable WebSocket receive path and one MQTTS publish path, verified independently.

## Phase 1 — Source protocol

- [ ] Implement `src/config.ts`: env validation, safe instance/topic name, root CA reading, secure URL rules.
- [ ] Implement `src/stackport/client.ts`: connect with header, hello/snapshot/update/heartbeat parser, protocol `v=1`, monotone `seq`, frame size/depth limits, 90s silence watchdog, backoff/jitter.
- [ ] Implement `src/domain/state.ts`: authoritative four-section latest snapshot, section replacement (arrays are never merged), freshness/availability.
- [ ] On reconnect, require a fresh full snapshot, reject premature updates and different instance/scope, avoid default `[]` or `null` values if no snapshot is known.
- [ ] Tests: schema, authentication denial, instance mismatch, sequence gaps, version mismatch, source stale, disconnect/reconnect and source unavailable.

**Exit:** cleanly maintains a bounded in-memory representation of current Stackport state.

## Phase 2 — MQTT state sink

- [ ] Implement `src/mqtt/client.ts`: existing Stackport-Mqtt broker TLS/CA/SNI, dedicated client, stable unique client ID, keepalive, QoS1 retained Will on bridge availability.
- [ ] Implement `src/mqtt/topics.ts`: fixed topic prefix and six whitelisted topic names from the contract; **no subscribe** and **no per-project retained topics**.
- [ ] Implement `src/bridge.ts`: serialize/coalesce latest section publications, track acknowledged values, bounded memory when offline, republish all four sections after reconnect and new source snapshot.
- [ ] Publish truthful source availability (`connecting/online/stale/offline`); never transform a source disconnect into a project state `down`.
- [ ] Exactly one live bridge instance may write a given prefix; reject wrong `SP_INSTANCE` on hello.
- [ ] Tests: full snapshot, single-section update, unchanged value, empty arrays, MQTT reconnect/full resync, LWT, QoS1 backpressure, order and duplicate events.

**Exit:** consumers subscribing to retained topics reconstruct the latest complete state after arbitrary reconnects.

## Phase 3 — Deployment and hardening

- [ ] Provide a **systemd unit or a host-side container** with no ingress ports, non-root user, read-only filesystem, no Docker socket, caps dropped; private `.env` outside git.
- [ ] Verify host-local Stackport `ws://127.0.0.1:3000/status/ws` actually works from the selected runtime; if not, use proper `wss://` via trusted proxy. Never weaken Stackport's transport rule.
- [ ] Verify Stackport-Mqtt local MQTTS listener through TCP proxy at `127.0.0.1:8883`, valid broker chain and `servername=mqtt.mattediworks.com`.
- [ ] Create a dedicated `stackport-bridge` broker user and publish-only Dynamic Security ACL; show denied out-of-scope publish attempts.
- [ ] Validate offline/online/stale transitions during independent Stackport, bridge and broker restarts, including retained topic convergence.
- [ ] Confirm that no token, password, header, private key, source payload or privileged URL is written to logs.
- [ ] Record real-VPS integration evidence and update [ENG-66](https://linear.app/mattediworks/issue/ENG-66/p1-validate-secure-internal-route-for-stackport-live-ws-mqtt-bridge).
- [ ] Confirm the source group-scoping defect in [ENG-65](https://linear.app/mattediworks/issue/ENG-65/p1-reconcile-scoped-live-status-sections-when-a-project-changes-groups) is fixed before offering group-restricted bridge subscriptions.

**Exit:** deployable v0, verified against real Stackport and Stackport-Mqtt, no unproven Internet-free assumptions.

## Deliberately excluded from v0

- Outbound control / RPC; HTTP admin API; database; notification history and exactly-once event processing.
- Per-project retained topics and tombstone manifests.
- Automatic token creation or MQTT broker administration; those remain controlled by Stackport and Stackport-Mqtt.
- Integration with MW Notification (independent lifecycle).

## Manual approval points before implementation

- Confirm the target process placement: **host-side systemd** (default) vs **host-network container** vs **managed container with public WSS route**.
- Confirm v0 `all`-scope, four-section retained state topics, and omission of event history.
- Confirm MQTT subscriber clients are provisioned separately and will handle **both** availability topics.
