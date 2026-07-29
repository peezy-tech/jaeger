import { homedir } from "node:os";
import { join } from "node:path";
import { CodexAppServer } from "./codex-app-server.mjs";
import {
  createJaegerReadonlyRequestHandlers,
  JAEGER_READONLY_TOOLS,
} from "./jaeger-readonly-tools.mjs";

const stateFile =
  process.env.VOICE_SPIKE_STATE_FILE ??
  join(
    process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
    "jaeger",
    "voice-spike",
    "operator.json",
  );
const jaegerEnv = {
  ...(process.env.VOICE_SPIKE_JAEGER_CONFIG_HOME
    ? { XDG_CONFIG_HOME: process.env.VOICE_SPIKE_JAEGER_CONFIG_HOME }
    : {}),
  ...(process.env.VOICE_SPIKE_JAEGER_SOCKET
    ? { JAEGER_SOCKET: process.env.VOICE_SPIKE_JAEGER_SOCKET }
    : {}),
};
const bridge = new CodexAppServer({
  codexBin: process.env.VOICE_SPIKE_CODEX_BIN ?? "codex",
  cwd: process.env.VOICE_SPIKE_CWD ?? "/home/peezy/repos/jaeger",
  childEnv: jaegerEnv,
  dynamicTools: JAEGER_READONLY_TOOLS,
  requestHandlers: createJaegerReadonlyRequestHandlers({
    jaegerBin: process.env.VOICE_SPIKE_JAEGER_BIN ?? "jaeger",
    env: jaegerEnv,
  }),
  stateFile,
});
const items = [];

bridge.on("item/completed", (params) => {
  if (params.threadId === bridge.threadId) items.push(params.item);
});

try {
  await bridge.start();
  const completed = bridge.waitForNotification(
    "turn/completed",
    (params) => params.threadId === bridge.threadId,
    120_000,
  );
  await bridge.request("turn/start", {
    threadId: bridge.threadId,
    input: [
      {
        type: "text",
        text: "Run jaeger status --json exactly once. Report the current runtime, active workflow count, total recorded workflows, and running session count. Do not mutate anything.",
      },
    ],
  });
  const result = await completed;
  const command = items.find((item) => item.type === "commandExecution");
  const dynamicTool = items.find((item) => item.type === "dynamicToolCall");
  const answer = items.findLast((item) => item.type === "agentMessage");
  process.stdout.write(
    `${JSON.stringify(
      {
        threadId: bridge.threadId,
        turnStatus: result.turn?.status,
        command: command?.command,
        commandStatus: command?.status,
        exitCode: command?.exitCode,
        tool: dynamicTool?.tool,
        toolStatus: dynamicTool?.status,
        toolSuccess: dynamicTool?.success,
        answer: answer?.text,
      },
      null,
      2,
    )}\n`,
  );
  const inspectionSucceeded =
    command?.exitCode === 0 ||
    (dynamicTool?.status === "completed" && dynamicTool?.success === true);
  if (result.turn?.status !== "completed" || !inspectionSucceeded) {
    process.exitCode = 1;
  }
} finally {
  await bridge.stop();
}
