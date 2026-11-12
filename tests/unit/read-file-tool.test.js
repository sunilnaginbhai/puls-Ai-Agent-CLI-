import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const previousWorkspace = process.env.PULS_AI_WORKSPACE;
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "puls-ai-read-tool-"));
process.env.PULS_AI_WORKSPACE = workspace;

await fs.writeFile(path.join(workspace, "sample.txt"), "alpha\nbeta\ngamma\n", "utf8");
await fs.writeFile(path.join(workspace, ".env"), "API_KEY=do-not-read\n", "utf8");
await fs.writeFile(
    path.join(workspace, "many-lines.txt"),
    Array.from({ length: 405 }, (_, index) => `line-${index + 1}`).join("\n"),
    "utf8"
);

const { readFileTool } = await import("../../src/tools/files/file.tools.js");
const rl = (await import("../../src/ui/readline.js")).default;
const outsideName = `${path.basename(workspace)}-outside.txt`;
await fs.writeFile(path.join(path.dirname(workspace), outsideName), "outside workspace\n", "utf8");

after(async () => {
    rl.close();
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(path.join(path.dirname(workspace), outsideName), { force: true });
    if (previousWorkspace === undefined) delete process.env.PULS_AI_WORKSPACE;
    else process.env.PULS_AI_WORKSPACE = previousWorkspace;
});

test("returns a requested line range with line numbers", async () => {
    const result = await readFileTool.invoke({
        path: "sample.txt",
        startLine: 2,
        endLine: 3,
    });

    assert.match(result, /2: beta/);
    assert.match(result, /3: gamma/);
    assert.doesNotMatch(result, /1: alpha/);
});

test("rejects paths outside the active workspace", async () => {
    await assert.rejects(
        readFileTool.invoke({ path: `../${outsideName}` }),
        /outside the active workspace/i
    );
});

test("refuses common credential files", async () => {
    await assert.rejects(
        readFileTool.invoke({ path: ".env" }),
        /credential or secret file is blocked/i
    );
});

test("rejects reversed line ranges", async () => {
    await assert.rejects(
        readFileTool.invoke({ path: "sample.txt", startLine: 3, endLine: 2 }),
        /endLine must be greater than or equal to startLine/i
    );
});

test("caps default output at the configured line limit", async () => {
    const result = await readFileTool.invoke({ path: "many-lines.txt" });

    assert.match(result, /1: line-1/);
    assert.match(result, /400: line-400/);
    assert.doesNotMatch(result, /401: line-401/);
    assert.match(result, /Output truncated/i);
});
