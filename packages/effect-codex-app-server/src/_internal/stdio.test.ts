import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Tracer from "effect/Tracer";
import { ChildProcessSpawner } from "effect/process";

import * as CodexError from "../errors.ts";
import { makeStderrClassifier, makeTerminationError } from "./stdio.ts";

describe("Codex App Server child process termination", () => {
  it("classifies bounded cross-chunk markers and records completed stderr", () => {
    const stderr = makeStderrClassifier();
    const encoder = new TextEncoder();
    assert.equal(stderr.result(), "none");
    assert.equal(stderr.isComplete(), false);
    stderr.observe(encoder.encode("private output ".repeat(10000) + "con"));
    stderr.observe(encoder.encode("fig failure"));
    assert.equal(stderr.result(), "configuration");
    stderr.observe(encoder.encode("pan"));
    stderr.observe(encoder.encode("ic unauthorized"));
    stderr.observe(new Uint8Array());
    assert.equal(stderr.result(), "panic");
    stderr.finish();
    assert.equal(stderr.isComplete(), true);
  });

  it.effect("records safe termination metadata without stderr contents", () => {
    const stderr = makeStderrClassifier();
    const encoder = new TextEncoder();
    stderr.observe(encoder.encode("unau"));
    stderr.observe(encoder.encode("thorized private-token-123"));
    const spans: Array<{ name: string; attributes: Record<string, unknown> }> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);
        span.end = (time, exit) => {
          end(time, exit);
          spans.push({ name: span.name, attributes: Object.fromEntries(span.attributes) });
        };
        return span;
      },
    });
    return Effect.gen(function* () {
      const error = yield* makeTerminationError(
        {
          pid: ChildProcessSpawner.ProcessId(52),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(4294967295)),
        },
        stderr.result,
      ).pipe(Effect.withTracer(tracer));
      assert.instanceOf(error, CodexError.CodexAppServerProcessExitedError);
      assert.equal(error.code, 4294967295);
      assert.deepEqual(spans[0]?.attributes, {
        "codex.child.pid": 52,
        "codex.child.phase": "exit",
        "codex.child.error_class": "CodexAppServerProcessExitedError",
        "codex.child.stderr_class": "authentication",
        "codex.child.stderr_complete": false,
        "codex.child.exit_signal": "unavailable",
        "codex.child.exit_code": 4294967295,
      });
      assert.notInclude(JSON.stringify(spans), "private-token-123");
    });
  });
  it.effect("retains the process identifier and exact exit-status cause", () =>
    Effect.gen(function* () {
      const rootCause = new Error("private process diagnostics");
      const cause = PlatformError.systemError({
        _tag: "Unknown",
        module: "ChildProcess",
        method: "exitCode",
        cause: rootCause,
      });
      const error = yield* makeTerminationError({
        pid: ChildProcessSpawner.ProcessId(52),
        exitCode: Effect.fail(cause),
      });

      assert.instanceOf(error, CodexError.CodexAppServerTransportError);
      assert.equal(error.pid, 52);
      assert.strictEqual(error.cause, cause);
      assert.equal(
        error.message,
        "Codex App Server transport operation 'read-process-exit-status' failed.",
      );
      assert.notInclude(error.message, rootCause.message);
    }),
  );
});
