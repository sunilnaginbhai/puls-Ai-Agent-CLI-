import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const previousWorkspace = process.env.PULS_AI_WORKSPACE;
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "puls-ai-directory-tools-"));
process.env.PULS_AI_WORKSPACE = workspace;
for (let index = 0; index < 205; index += 1) {
    await fs.writeFile(path.join(workspace, `file-${String(index).padStart(3, "0")}.txt`), "x", "utf8");
}

const { listDirectoryTool, scanDirectoryTool } = await import("../../src/tools/files/file.tools.js");
const rl = (await import("../../src/ui/readline.js")).default;

after(async () => {
    rl.close();
    await fs.rm(workspace, { recursive: true, force: true });
    if (previousWorkspace === undefined) delete process.env.PULS_AI_WORKSPACE;
    else process.env.PULS_AI_WORKSPACE = previousWorkspace;
});

test("limits directory listing output and marks truncated results", async () => {
    const result = JSON.parse(await listDirectoryTool.invoke({ directory: "." }));

    assert.equal(result.entries.length, 200);
    assert.equal(result.truncated, true);
});

test("limits recursive scan output and marks truncated results", async () => {
    const result = JSON.parse(await scanDirectoryTool.invoke({ directory: "." }));

    assert.equal(result.results.length, 200);
    assert.equal(result.truncated, true);
});

test('directory tools honor cancellation and remain usable afterward', async () => {
    for (const tool of [listDirectoryTool, scanDirectoryTool]) {
        const controller = new AbortController();
        const result = tool.invoke({ directory: '.' }, { signal: controller.signal });
        setImmediate(() => controller.abort());
        await assert.rejects(result, { name: 'AbortError' });
        const response = JSON.parse(await tool.invoke({ directory: '.' }));
        assert.equal((response.entries ?? response.results).length, 200);
    }
});
