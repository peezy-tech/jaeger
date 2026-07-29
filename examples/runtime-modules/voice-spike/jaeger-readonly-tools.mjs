import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const JAEGER_READONLY_TOOLS = [
  {
    type: "function",
    name: "jaeger_status",
    description:
      "Read the current installed Jaeger backend status. This tool cannot mutate Jaeger.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

export function createJaegerReadonlyRequestHandlers({
  jaegerBin = "jaeger",
  execute = execFileAsync,
} = {}) {
  return {
    "item/tool/call": async (params) => {
      if (
        params.namespace != null ||
        params.tool !== "jaeger_status" ||
        !isEmptyObject(params.arguments)
      ) {
        return {
          contentItems: [
            {
              type: "inputText",
              text: "Rejected: this compatibility spike exposes only jaeger_status with no arguments.",
            },
          ],
          success: false,
        };
      }

      try {
        const { stdout } = await execute(
          jaegerBin,
          ["status", "--json"],
          {
            encoding: "utf8",
            timeout: 15_000,
            maxBuffer: 1_000_000,
          },
        );
        const status = JSON.parse(stdout);
        return {
          contentItems: [
            { type: "inputText", text: JSON.stringify(status) },
          ],
          success: true,
        };
      } catch (error) {
        return {
          contentItems: [
            {
              type: "inputText",
              text: `Jaeger status failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          success: false,
        };
      }
    },
  };
}

function isEmptyObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}
