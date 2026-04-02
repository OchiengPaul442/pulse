import Ajv, { ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

export type JsonSchema = Record<string, unknown>;

export interface ToolRegistration {
  name: string;
  description?: string;
  schema?: JsonSchema;
  prompt?: string;
}

export class ToolRegistry {
  private readonly registry = new Map<string, ToolRegistration>();
  private readonly validators = new Map<string, ValidateFunction>();
  private readonly ajv: Ajv;

  public constructor() {
    this.ajv = new Ajv({ strict: false, allowUnionTypes: true });
    addFormats(this.ajv);
  }

  public register(
    name: string,
    schema?: JsonSchema,
    description?: string,
    prompt?: string,
  ): void {
    this.registry.set(name, { name, schema, description, prompt });
    if (schema) {
      try {
        const validate = this.ajv.compile(schema as object);
        this.validators.set(name, validate as ValidateFunction);
      } catch (err) {
        // compilation failed — keep registry entry but no validator
      }
    }
  }

  public has(name: string): boolean {
    return this.registry.has(name);
  }

  public get(name: string): ToolRegistration | undefined {
    return this.registry.get(name);
  }

  public getPrompt(name: string): string | undefined {
    return this.registry.get(name)?.prompt;
  }

  public list(): ToolRegistration[] {
    return Array.from(this.registry.values());
  }

  public validate(
    name: string,
    value: unknown,
  ): { ok: true } | { ok: false; errors: string[] } {
    const validate = this.validators.get(name);
    if (!validate) return { ok: true };
    const valid = validate(value);
    if (valid) return { ok: true };
    const errors = (validate.errors ?? []).map(
      (e) => `${e.instancePath || "$"} ${e.message ?? "validation error"}`,
    );
    return { ok: false, errors };
  }
}

export default ToolRegistry;
