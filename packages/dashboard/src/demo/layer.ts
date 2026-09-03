import { KvTriples } from "@bjacobso/triplex";
import { ConfigStore } from "@bjacobso/triplex/config";
import { Effect, Layer } from "effect";

import { seedLearningDemo } from "./learning.js";

const BaseDashboardLayer = ConfigStore.layer.pipe(
  Layer.provideMerge(KvTriples.layerWithScope("triplex-dashboard-demo")),
);

/** Browser-local composition for the standalone classroom demo. */
export const DashboardDemoLayer = Layer.merge(
  BaseDashboardLayer,
  Layer.effectDiscard(seedLearningDemo.pipe(Effect.orDie)).pipe(Layer.provide(BaseDashboardLayer)),
);
