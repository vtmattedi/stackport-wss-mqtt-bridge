# Deployment design — Stackport and Stackport-Mqtt on one VPS

**Design, not deployment instructions for a finished executable.** The repository does not contain the v0 bridge implementation yet. These steps define what its installer and integration test must satisfy.

## Dependencies already available

1. Stackport **v1.3.11 or later** (PR [#41](https://github.com/vtmattedi/Stackport/pull/41) merged) exposes a **receive-only raw WebSocket** at `/status/ws`.
2. [Stackport-Mqtt](https://github.com/vtmattedi/Stackport-mqtt) runs Mosquitto 2.x on TLS-only `8883` (Stackport-managed TCP exposure) and a separate browser WebSocket listener on `9001`. **Use 8883, not 9001.**
3. A verified NM Root CA certificate is committed at [`certs/nm-root-ca.crt`](../certs/nm-root-ca.crt).

## Credentials and broker ACL

### Stackport

In **Settings → Live status**:

- Enable the stream.
- Copy its stable **instance ID** (e.g. `sp-...`) into `SP_INSTANCE`.
- Create a new token with **status** scope and access to all projects (`SP_EXPECTED_SCOPE=all`). Keep it only in `SP_STATUS_TOKEN`.
- Do not use an admin browser session, an MCP read/write token or a token in the WebSocket URL.
- Rotate/revoke the token independently if this bridge is compromised; active sockets are revalidated approximately every 30 seconds.

### Stackport-Mqtt

Use the broker's existing Mosquitto Dynamic Security controls to create a dedicated service client, e.g. `stackport-bridge`, with a unique **24+ character** password.

- Create a dedicated role, e.g. `sp-bridge-publisher`.
- The role grants **`publishClientSend` allow only on `stackport/<SP_INSTANCE>/#`**; no subscribe ACLs, no other topic prefixes, and no `$CONTROL` rights.
- Attach this role to only the bridge client.
- This is the same ACL model used in Stackport-Mqtt's [provision-client.sh](https://github.com/vtmattedi/Stackport-mqtt/blob/main/scripts/provision-client.sh) and [setup-roles.sh](https://github.com/vtmattedi/Stackport-mqtt/blob/main/scripts/setup-roles.sh), but **not** the broad `nmnw` role or the privileged `dynsec-admin` role.
- Separately provision dashboard/NMNW **read-only** subscribers if those clients need to consume `stackport/<SP_INSTANCE>/#`.
- Check retained delivery, QoS1 acknowledgments, offline Last Will publishing, and ACL rejection of an unrelated test topic.

Never put MQTT administrative tokens, the broker bootstrap password, or the private Root CA key into this bridge. Only a scoped publishing identity is required.

## Recommended v0 network path: host-local process

A standalone **unprivileged systemd service on the VPS host** is simplest for two local endpoints while preserving Stackport's intentional isolation from managed-project Docker networks:

```text
Host-side bridge process (no listener)
   ├── ws://127.0.0.1:3000/status/ws       (Stackport HTTP port, direct host loopback)
   └── mqtts://127.0.0.1:8883               (Stackport's existing TCP exposure)
                           TLS SNI: mqtt.mattediworks.com
                           CA: certs/nm-root-ca.crt
```

- Stackport's live stream explicitly permits **unproxied same-host loopback**; it **does not** permit ordinary cleartext traffic from a separate Docker container.
- The broker's public TCP exposure must actually accept localhost connections on the VPS. Check before relying on it; if it does not, select one of the alternatives below.
- `MQTT_URL=mqtts://127.0.0.1:8883` is merely the **TCP destination**. Set `MQTT_TLS_SERVERNAME=mqtt.mattediworks.com` and validate the certificate hostname against that domain; otherwise the cert's SAN will not match `127.0.0.1`.
- This path **requires no external Internet traffic** after services and packages are provisioned. It does **not automatically firewall Internet egress**; enforce that separately if required.
- Run as a dedicated non-root user with read access only to the private `.env` and public CA, no Docker group membership, and no inbound TCP ports. Keep logs local and secret-free.
- Let systemd restart on failure with backoff. The bridge itself handles temporary disconnections.

**Do not call `ws://stackport:3000/status/ws` from an ordinary project container**: even if a route exists, Stackport's transport check denies a non-loopback cleartext WebSocket.

### Deployment alternatives

| Mode | Stackport transport | MQTT transport | Tradeoff |
| --- | --- | --- | --- |
| **Host-side Bun + systemd (v0 preferred)** | `ws://127.0.0.1:3000/status/ws` | `mqtts://127.0.0.1:8883` with CA+SNI | Both endpoints local, no Docker network coupling |
| Dedicated **host-network** container | Same host-loopback path | Same TLS local TCP proxy | Simple packaging; shares host network namespace and must not gain Docker socket / privileges |
| Ordinary managed container | `wss://<Stackport HTTPS domain>/status/ws` | Internal broker network `mqtt:8883` or external MQTTS endpoint | Stronger container isolation; requires a carefully verified SSL, DNS, and Docker network route |

For a managed container, keep its inbound ports closed, use only a narrowly attached broker network, and rely on the authenticated WSS endpoint. Do not attach the Stackport management container to broad managed-project networks simply to make the bridge connect.

The internal route remains subject to [ENG-66](https://linear.app/mattediworks/issue/ENG-66/p1-validate-secure-internal-route-for-stackport-live-ws-mqtt-bridge) integration verification. **No deployment topology is claimed tested yet.**

## Private environment

Copy [`.env.example`](../.env.example) to `.env` and fill secret fields. Do not commit it.

```dotenv
SP_INSTANCE=sp-replace-with-settings-instance
SP_EXPECTED_SCOPE=all
SP_WS_URL=ws://127.0.0.1:3000/status/ws
SP_STATUS_TOKEN=spk_<status-only-secret>

MQTT_URL=mqtts://127.0.0.1:8883
MQTT_TLS_SERVERNAME=mqtt.mattediworks.com
MQTT_CA_FILE=./certs/nm-root-ca.crt
MQTT_CLIENT_ID=stackport-bridge-one
MQTT_USERNAME=stackport-bridge
MQTT_PASSWORD=<dedicated-broker-password>
```

Host-side service paths must resolve `MQTT_CA_FILE` relative to the project root (or use an absolute path). Treat the root CA as public, but protect its integrity; don't silently replace it based on data from a server.

### Validate the broker trust chain

From the VPS, once the TCP exposure is live:

```bash
openssl s_client -brief -connect 127.0.0.1:8883 \
  -servername mqtt.mattediworks.com \
  -verify_hostname mqtt.mattediworks.com \
  -CAfile certs/nm-root-ca.crt < /dev/null
```

The supplied root is self-signed and was parsed/verified locally:

- Subject/issuer: `O=NM, CN=NM Root CA`
- Validity: 2026-10-06 through 2036-10-03 UTC
- SHA-256: `9A:7B:A6:AD:5E:4C:15:F6:14:65:1C:30:B9:D9:35:78:7C:B7:00:81:24:2D:79:A3:5B:41:6C:BF:DD:6A:2D:DC`

**This only validates the provided CA certificate.** A real MQTTS connection and verification of the running broker's leaf/full chain remain required before deployment.

### Verify the Stackport stream

Use a non-browser WebSocket client capable of setting a custom `Authorization` header. Check the `hello` frame and fresh `snapshot`, and verify that a direct cleartext connection from a remote container is refused.

A status token is only accepted after the endpoint has been enabled. Stackport returns 404 while it is disabled.

## Runbook (after implementation)

1. Back up both service credentials; do not commit private `.env`.
2. Enable the Stackport live status stream and create its status-only token.
3. Provision the dedicated Stackport-Mqtt publisher and narrow ACL.
4. Validate the WebSocket handshake, MQTT TLS certificate and broker ACL on the real VPS.
5. Start exactly one bridge instance. Wait for an initial `snapshot` and four successful retained section publishes.
6. Subscribe from a separately authorized MQTT consumer to `stackport/<instance>/#`; confirm `bridge/availability`, `source/availability`, and the four section topics.
7. Restart Stackport, the bridge, and Mosquitto separately. Confirm offline/stale status is truthful and current state is fully restored without clearing all projects.

**Release gate:** don't declare v0 operational merely because CI is green; verify the real network paths and broker CA chain (ENG-66).
