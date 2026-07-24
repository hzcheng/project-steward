# AI Session Attention / Runtime Decoupling Design

Date: 2026-07-24
Status: Approved by the user's standing implementation authorization

## Problem

The attention controller currently converts a completed runtime into a
synthetic `terminal-exit:*` completion signal. A shell exit, terminal close, or
tmux disappearance can therefore create a red unread indicator even when the
provider emitted no attention-worthy lifecycle event.

The runtime settlement code compounds the problem by retaining completed
runtime ownership until an attention event has been published. CI encodes both
behaviors as P0 contracts, so fixes that distinguish close reasons or
deduplicate events preserve the incorrect premise instead of removing it.

## Decision

Attention is an unread provider-event model. Runtime state is a resource and
execution-liveness model. They share session/run identity, but one must not
infer the other.

| Input | Runtime effect | Attention effect |
| --- | --- | --- |
| Provider `task_complete` / equivalent | execution may stop | create or retain one unread `completed` event |
| Provider input request | execution may stop | create or retain one unread `input-required` event |
| Provider failure | execution may stop | create or retain one unread `failed` event |
| Provider abort / interrupt | execution stops | transition to idle and create no event |
| Provider running event | execution is running | clear stale attention for the superseded run |
| Direct process exit / completion marker | runtime becomes completed | no synthesized event |
| User closes a VS Code terminal | runtime is removed | no synthesized event; acknowledge existing event |
| Project Steward closes a Direct session | runtime is removed | no synthesized event; acknowledge existing event after success |
| tmux runtime becomes inactive | runtime is released from active ownership | no synthesized event |
| Project Steward detaches tmux | attachment is removed | acknowledge existing event after success; future provider events remain eligible |

Provider lifecycle parsing remains the only source of new attention. Existing
event acknowledgement, bridge aggregation, stale-run clearing, and
cross-window rendering remain unchanged.

## Runtime Settlement

A completed runtime is evaluated once before release so a provider event can be
captured and published.

- If evaluation finds an attention event, release only after publication
  succeeds (or the event is explicitly accounted for by overflow handling).
- If evaluation finds no attention event, release immediately after the
  successful evaluation; there is nothing to deliver.
- If attention is disabled, the runtime is out of scope, or the runtime is
  already stopped, release it.
- If evaluation throws, or publishing an actual event fails, retain the runtime
  for retry.

This preserves delivery reliability without manufacturing an event merely to
make cleanup eligible.

## Removed Compatibility Behavior

- Remove the `isRuntimeComplete` attention-controller option.
- Remove the `terminal-exit:*` synthetic signal.
- Remove runtime-completion suppression/restoration state and its close-race
  wiring.
- Replace CI contracts that require natural process exit to preserve synthetic
  attention.

## Verification

Automated contracts must prove:

- a completed runtime with no provider signal publishes no item;
- provider completion remains unread across a later runtime exit without
  duplication;
- a completed runtime with no event is released after evaluation;
- an unpublished provider event retains runtime ownership for retry;
- natural process exit never invokes acknowledgement or completion
  suppression;
- user-confirmed close still acknowledges an already existing provider event;
- source/architecture guards reject reintroduction of `terminal-exit:*`.
