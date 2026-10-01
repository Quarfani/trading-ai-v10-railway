import { selectDeploymentParams, OptimParams } from "../optimization/WalkForwardOptimizer";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const first: OptimParams = { atrMult:1, tpRatio:2, minConfidence:0.55, rollingWindow:30 };
const latest: OptimParams = { atrMult:2, tpRatio:3, minConfidence:0.7, rollingWindow:40 };
const selected = selectDeploymentParams([{ bestParams:first }, { bestParams:latest }]);

assert(selected?.atrMult === 2, "latest training parameters must be selected");
assert(selected?.tpRatio === 3, "latest training TP ratio must be selected");
assert(selectDeploymentParams([]) === null, "empty WFO must have no deployment parameters");

console.log("Result: 4 passed, 0 failed");