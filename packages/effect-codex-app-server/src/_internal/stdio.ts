import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import * as CodexError from "../errors.ts";

const encoder = new TextEncoder();

export const makeChildStdio = (handle: ChildProcessSpawner.ChildProcessHandle) =>
  Stdio.make({
    args: Effect.succeed([]),
    stdin: handle.stdout,
    stdout: () =>
      Sink.mapInput(handle.stdin, (chunk: string | Uint8Array) =>
        typeof chunk === "string" ? encoder.encode(chunk) : chunk,
      ),
    stderr: () => Sink.drain,
  });

export const makeInMemoryStdio = Effect.fn("makeInMemoryStdio")(function* () {
  const input = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const output = yield* Queue.unbounded<string>();
  const decoder = new TextDecoder();

  return {
    stdio: Stdio.make({
      args: Effect.succeed([]),
      stdin: Stream.fromQueue(input),
      stdout: () =>
        Sink.forEach((chunk: string | Uint8Array) =>
          Queue.offer(
            output,
            typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }),
          ),
        ),
      stderr: () => Sink.drain,
    }),
    input,
    output,
  };
});

type ChildProcessTerminationHandle = Pick<
  ChildProcessSpawner.ChildProcessHandle,
  "exitCode" | "pid"
>;

export type StderrClassification = "none" | "other" | "panic" | "configuration" | "authentication";

export const makeStderrClassifier = () => {
  const decoder = new TextDecoder();
  let tail = "";
  let classification: StderrClassification = "none";
  let complete = false;
  return {
    observe: (chunk: Uint8Array) => {
      if (chunk.length === 0) return;
      const text = tail + decoder.decode(chunk, { stream: true }).toLowerCase();
      if (text.includes("panic")) classification = "panic";
      else if (classification !== "panic" && text.includes("config"))
        classification = "configuration";
      else if (classification === "none" || classification === "other") {
        classification = text.includes("unauthorized") ? "authentication" : "other";
      }
      tail = text.slice(-16);
    },
    result: () => classification,
    finish: () => {
      complete = true;
    },
    isComplete: () => complete,
  };
};

export const makeTerminationError = Effect.fn("CodexAppServer.childExit")(function* (
  handle: ChildProcessTerminationHandle,
  stderrClassification: () => StderrClassification = () => "none",
  stderrComplete: () => boolean = () => false,
): Effect.fn.Return<CodexError.CodexAppServerError> {
  const error = yield* Effect.match(handle.exitCode, {
    onFailure: (cause) =>
      new CodexError.CodexAppServerTransportError({
        operation: "read-process-exit-status",
        pid: handle.pid,
        cause,
      }),
    onSuccess: (code) => new CodexError.CodexAppServerProcessExitedError({ code, pid: handle.pid }),
  });
  yield* Effect.annotateCurrentSpan({
    "codex.child.pid": handle.pid,
    "codex.child.phase": "exit",
    "codex.child.error_class": error._tag,
    "codex.child.stderr_class": stderrClassification(),
    "codex.child.stderr_complete": stderrComplete(),
    // The process handle exposes an exit code, not the OS termination signal.
    "codex.child.exit_signal": "unavailable",
    ...(error._tag === "CodexAppServerProcessExitedError" && error.code !== undefined
      ? { "codex.child.exit_code": error.code }
      : {}),
  });
  return error;
});
