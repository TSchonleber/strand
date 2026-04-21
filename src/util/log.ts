import { env } from "@/config";
import pino from "pino";

const isDev = env.NODE_ENV === "development";

export const log = pino({
  level: env.LOG_LEVEL,
  base: { svc: "strand" },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      "*.XAI_API_KEY",
      "*.X_CLIENT_SECRET",
      "*.X_BEARER_TOKEN",
      "*.X_USER_ACCESS_TOKEN",
      "*.X_USER_REFRESH_TOKEN",
      "*.BRAINCTL_REMOTE_MCP_TOKEN",
      "*.SLACK_WEBHOOK_URL",
      "authorization",
      "Authorization",
    ],
    remove: true,
  },
  ...(isDev ? { transport: { target: "pino-pretty", options: { colorize: true } } } : {}),
});

export function loopLog(loop: string): pino.Logger {
  return log.child({ loop });
}
