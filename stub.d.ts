declare const args: any;
interface Agent { ask<T>(prompt: string): Promise<T>; }
declare function agent(name: string, persona?: string): Agent;
declare function phase(name: string): void;
declare function log(message: string): void;
declare function report(value: unknown, scope?: string): void;
declare const world: { run(cmd: string, args?: string[], opts?: { timeoutMs?: number }): Promise<{ exitCode: number; stdout: string; stderr: string }> };
declare const artifact: { chart(id: string, spec: unknown): void; board(id: string, spec: unknown): void; markdown(id: string, spec: unknown, opts?: unknown): Promise<void>; file(id: string, spec: unknown, opts?: unknown): Promise<void> };
