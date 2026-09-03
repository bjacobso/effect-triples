#!/usr/bin/env -S node --disable-warning=ExperimentalWarning

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { reportFailure, run } from "./program.js";

run.pipe(
  Effect.catchCause(reportFailure),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
