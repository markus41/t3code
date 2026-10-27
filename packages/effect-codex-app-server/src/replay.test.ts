import { assert, live } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as CodexClient from "./client.ts";
import * as CodexReplay from "./replay.ts";

live("replay stays alive while waiting for its next outbound frame", () =>
  Effect.gen(function* () {
    const client = yield* CodexClient.CodexAppServerClient;
    const result = yield* client.termination.pipe(Effect.timeoutOption("1500 millis"));
    assert.isTrue(Option.isNone(result));
  }).pipe(
    Effect.provide(
      CodexReplay.layerReplay({
        provider: "codex",
        protocol: "codex.app-server",
        version: "test",
        scenario: "wait-for-outbound",
        entries: [{ type: "expect_outbound", frame: { method: "initialize", id: 1 } }],
      }),
    ),
    Effect.scoped,
  ),
);
