import { env } from "@/config";
import { registerShutdown, start } from "@/orchestrator";
import { log } from "@/util/log";

log.info({ mode: env.STRAND_MODE, node_env: env.NODE_ENV }, "strand.boot");
registerShutdown();
start();
