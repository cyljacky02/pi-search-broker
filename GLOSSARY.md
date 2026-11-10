# Search Broker

A local broker that sits between pi-web-access and the Exa / Tavily search providers, spreading requests across several provider accounts and keeping track of what each one has spent.

## Language

### Accounts and credit

**Provider**:
An upstream search service the broker forwards to: Exa (billed in USD) or Tavily (billed in credits).
_Avoid_: Backend, upstream (as a noun for the service)

**Account**:
One provider account, with its own API key and its own credit, that the broker can send requests through.
_Avoid_: Key, team, user

**Key file**:
A private text file that lists one provider's API keys, one per line, together with the allocations every key in it gets. Each key in it is one account, and the key file is the only source of those accounts: removing a key removes its account.
_Avoid_: Key list, import file

**Account pool**:
All accounts for one provider that the broker rotates through.
_Avoid_: Key pool, manager

**Account health**:
Whether an account is eligible for new attempts, including accounts paused by a human or restricted by a provider.
_Avoid_: Status

**Allocation**:
A slice of an account's credit with a limit and a period: either `monthly` (it resets on a set day of the month) or `once` (a promo grant that may expire).
_Avoid_: Bucket, grant, quota

**Reservation**:
Credit held on one account's allocations for one in-flight request. It ends exactly once: the request is billed, it fails, or the credit is given back.
_Avoid_: Lease, hold, token

**Brokered request**:
A client search or content request routed through a provider's account pool; it may involve multiple attempts.
_Avoid_: Provider call

**Attempt**:
One try of a client request against one account. A single request may make several attempts across an account pool.
_Avoid_: Try, call

**Possibly billed**:
The state of an attempt that may have reached the provider but whose outcome is unknown (a timeout, the client went away, an unreadable reply, or an ambiguous connection failure). It is charged at the estimate and never retried on another account.
_Avoid_: Uncertain, lost

**Provider balance**:
The remaining credit as reported by the provider's own balance endpoint. It is shown next to the local figures and never applied to them automatically.
_Avoid_: Reconciled balance, remote balance

### Running the broker

**Broker**:
The whole product: the gateway, its account pools, and the tools to run and inspect it.
_Avoid_: Key manager, proxy

**Broker control**:
The operations for inspecting the broker and managing its accounts, distinct from submitting search requests.
_Avoid_: Management API

**Gateway**:
The loopback HTTP endpoint that pi-web-access sends Exa and Tavily requests to in place of the providers.
_Avoid_: Server, proxy

**Port owner**:
The single process on a machine that runs the gateway on the fixed port. Every other pi process is a **client** of it and takes over the port when the owner exits.
_Avoid_: Host, leader, primary

**Paused**:
The broker's state after it fails to save account state: no new attempt starts until a save succeeds. An attempt that was billed or possibly billed just before the failed save is reported to the client as aborted, so it is not retried elsewhere.
_Avoid_: Read-only, storage error (for the state itself)

### Access

**Gateway token**:
The local secret that pi-web-access presents to the broker in place of a real provider key.
_Avoid_: Token (unqualified), broker key
