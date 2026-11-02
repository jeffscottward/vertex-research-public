import { runGatewayTests } from "./gateway-test/runner.ts";
import { createGatewayDependencies } from "./gateway-test/system.ts";

process.exitCode = runGatewayTests(createGatewayDependencies());
