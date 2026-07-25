import { Ajv2020 } from "ajv/dist/2020.js";
import { StructuredOutputError } from "./errors.js";
import type { JsonSchema } from "./types.js";

const ajv = new Ajv2020({ allErrors: true, strict: false });

export function parseStructuredOutput(text: string, schema: JsonSchema): unknown {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new StructuredOutputError("Harness response was not valid JSON", { cause: error });
  }
  return validateStructuredOutput(value, schema);
}

export function validateStructuredOutput(value: unknown, schema: JsonSchema): unknown {
  return compileStructuredOutputValidator(schema)(value);
}

export function compileStructuredOutputValidator(
  schema: JsonSchema,
): (value: unknown) => unknown {
  let validate;
  try {
    validate = ajv.compile(schema);
  } catch (error) {
    throw new StructuredOutputError("Workflow supplied an invalid JSON Schema", { cause: error });
  }
  if ((validate as typeof validate & { readonly $async?: boolean }).$async === true) {
    throw new StructuredOutputError(
      "Workflow supplied an asynchronous JSON Schema; Jaeger schemas must validate synchronously",
    );
  }
  return (value: unknown): unknown => {
    if (!validate(value)) {
      const details = ajv.errorsText(validate.errors, { separator: "; " });
      throw new StructuredOutputError(`Harness response did not match its schema: ${details}`);
    }
    return value;
  };
}
